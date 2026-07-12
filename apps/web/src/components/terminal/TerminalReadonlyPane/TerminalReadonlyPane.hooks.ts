/** TerminalReadonlyPane effects: fetch a persisted session's scrollback and replay
 *  it into a fresh, input-disabled xterm (the `.tsx` stays a thin shell — no
 *  refs/effects in the component body). Unlike the live pane, a restored replay is
 *  static, so the instance is owned locally and disposed on unmount (no module
 *  cache — nothing keeps streaming). */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import { readTerminalPersisted } from '@/lib/bridge';

import { decodeScrollback, resolveTerminalTheme, TERMINAL_RENDER_OPTIONS } from '../terminal-shared';

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

/** Open a read-only xterm into this pane's container and write the persisted
 *  session's decoded scrollback into it once. Fetches the bytes for `id` on mount
 *  (or when it changes) and disposes the instance on unmount. */
export function useTerminalReadonlyPane(id: string) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let disposed = false;
    const term = new Terminal(buildReadonlyOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
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
      term.dispose();
    };
  }, [id]);

  return { containerRef };
}
