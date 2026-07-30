/** TerminalReadonlyPane effects: fetch a persisted session's scrollback, replay it
 *  into a fresh, input-disabled xterm, and drive the find bar over it (the `.tsx` stays
 *  a thin shell — no refs/effects in the component body). Unlike the live pane, a
 *  restored replay is static, so the instance is owned LOCALLY and disposed on unmount
 *  (no module cache — nothing keeps streaming). That local ownership is also why the
 *  find bar can't reuse `useTerminalSearch`, which resolves its addon through the live
 *  session manager's cache: a restored session has no entry there. */
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { readTerminalPersisted } from '@/lib/bridge';

import { isMacPlatform } from '../terminal-platform';
import {
  decodeScrollback,
  resolveTerminalTheme,
  TERMINAL_RENDER_OPTIONS,
  TERMINAL_SEARCH_DECORATIONS,
} from '../terminal-shared';

/** Read-only xterm options: the shared render config plus the token-resolved theme
 *  (#235), no cursor, stdin disabled so the replay can't be typed into. Built per open
 *  (not a module const) so the theme is read from the live design tokens at mount, not
 *  at import time. */
function buildReadonlyOptions() {
  return {
    ...TERMINAL_RENDER_OPTIONS,
    theme: resolveTerminalTheme(),
    cursorBlink: false,
    disableStdin: true,
  };
}

const NO_RESULTS = { resultIndex: -1, resultCount: 0 };

/** The find-bar state a restored pane binds to — the same shape the live pane exposes,
 *  so both drive the shared `TerminalSearchBar`. */
export interface RestoredSearch {
  readonly open: boolean;
  readonly query: string;
  readonly noMatch: boolean;
  readonly resultIndex: number;
  readonly resultCount: number;
  readonly onQueryChange: (value: string) => void;
  readonly next: () => void;
  readonly prev: () => void;
  readonly close: () => void;
  /** Open the bar from the pane's own button (the replay has no focused textarea to
   *  bubble ⌘F out of until the user clicks into it, so a visible affordance matters
   *  more here than on the live pane). */
  readonly openBar: () => void;
}

/** What the pane binds: the replay container, the region the ⌘F listener sits on, and
 *  the search state. */
export interface RestoredPaneView {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly search: RestoredSearch;
}

/**
 * Open a read-only xterm into this pane's container, write the persisted session's
 * decoded scrollback into it once, and make that scrollback SEARCHABLE (#405) — a
 * restored tab is usually opened precisely to find something in it, and until now the
 * only way through a 10k-line replay was scrolling.
 *
 * Fetches the bytes for `id` on mount (or when it changes) and disposes on unmount.
 */
export function useTerminalReadonlyPane(id: string): RestoredPaneView {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [noMatch, setNoMatch] = useState(false);
  const [results, setResults] = useState(NO_RESULTS);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let disposed = false;
    const term = new Terminal(buildReadonlyOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    const resultsSub = search.onDidChangeResults(setResults);
    term.open(container);
    const applyFit = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // A zero/detached host can throw mid-teardown; ignore.
      }
    };
    requestAnimationFrame(applyFit);

    void readTerminalPersisted(id).then((persisted) => {
      // The pane may have unmounted while the read was in flight.
      if (disposed) return;
      term.write(decodeScrollback(persisted.dataBase64));
      applyFit();
    });

    return () => {
      disposed = true;
      resultsSub.dispose();
      searchRef.current = null;
      term.dispose();
    };
  }, [id]);

  // ⌘F / Ctrl+F over the replay region. A native listener (not a JSX handler) so the
  // read-only surface stays a plain container, matching the live pane's find bar.
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const primary = isMacPlatform() ? e.metaKey : e.ctrlKey;
      if (primary && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setOpen(true);
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, []);

  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (value === '') {
      searchRef.current?.clearDecorations();
      setNoMatch(false);
      setResults(NO_RESULTS);
      return;
    }
    // Incremental: search from the current viewport as the user types.
    const found =
      searchRef.current?.findNext(value, {
        incremental: true,
        decorations: TERMINAL_SEARCH_DECORATIONS,
      }) ?? false;
    setNoMatch(!found);
  }, []);

  const next = useCallback(() => {
    if (query === '') return;
    const found =
      searchRef.current?.findNext(query, { decorations: TERMINAL_SEARCH_DECORATIONS }) ?? false;
    setNoMatch(!found);
  }, [query]);

  const prev = useCallback(() => {
    if (query === '') return;
    const found =
      searchRef.current?.findPrevious(query, { decorations: TERMINAL_SEARCH_DECORATIONS }) ?? false;
    setNoMatch(!found);
  }, [query]);

  const close = useCallback(() => {
    searchRef.current?.clearDecorations();
    setOpen(false);
    setNoMatch(false);
    setResults(NO_RESULTS);
  }, []);

  const openBar = useCallback(() => setOpen(true), []);

  return {
    containerRef,
    rootRef,
    search: {
      open,
      query,
      noMatch,
      resultIndex: results.resultIndex,
      resultCount: results.resultCount,
      onQueryChange,
      next,
      prev,
      close,
      openBar,
    },
  };
}
