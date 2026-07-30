/**
 * Clipboard + input smarts for the Terminal cockpit (spec PR 3b), wired onto each
 * live xterm via `attachCustomKeyEventHandler`. One place decides, per keydown,
 * whether xterm forwards the key to the PTY or the cockpit handles it:
 *
 *  - **Smart copy** (⌘C / Ctrl+C): copy a non-empty selection to the clipboard and
 *    swallow the key; with no selection, fall through so the shell still receives
 *    SIGINT (`\x03`) on Ctrl+C.
 *  - **Paste** (⌘V; Ctrl+V / Ctrl+Shift+V): read `navigator.clipboard` (no Tauri
 *    clipboard plugin exists), cap at 1 MB, and `term.paste()` — which brackets the
 *    payload itself when the program enabled `?2004h`, so a multiline paste can't
 *    execute line-by-line.
 *  - **Shift+Enter** → `ESC` + `\n` (`\x1b\n`): a newline into a TUI without submit.
 *  - **⌘/Ctrl+Backspace** → `Ctrl+U` (`\x15`): kill line.
 *  - **App chords** (⌘T/W/F, ⌘⇧E, ⌘1..9): swallowed here so xterm never forwards them
 *    to the PTY (on non-mac, Ctrl+T/W/F would otherwise send control bytes); the React
 *    layer (view shortcuts / pane search / grid zoom / tab select) performs the action.
 *  - **OSC 133 navigation** (⌘↑ / ⌘↓ / ⌘⇧O, #405): jump to the previous/next shell
 *    prompt and copy the last command's output. These are only meaningful once the
 *    shell emits OSC 133 marks; with a bare shell the injected actions are no-ops, and
 *    the chord is still swallowed rather than sent as a control byte.
 *
 * The two byte-emitting intents (Shift+Enter, kill-line) bypass xterm's `onData`, so
 * they write through the injected {@link EmitBroadcast} rather than the bridge directly
 * — that funnels them through the session manager's broadcast fan-out (round-2 PR B),
 * so an armed broadcast reaches every visible pane. Paste is NOT injected: `term.paste`
 * delivers through xterm's `onData`, which the session manager already routes through
 * the same fan-out (so a broadcast paste rides the typing path — no double-send).
 *
 * The clipboard cap is a module-level notifier (mirroring the session manager's
 * activity subscription) so the non-React manager can tell the view to toast.
 */
import type { Terminal } from '@xterm/xterm';

import { isMacPlatform } from './terminal-platform';

/** Max bytes accepted from a single clipboard paste (spec PR 3b). Larger payloads
 *  are dropped with a toast rather than flooding the PTY. */
export const PASTE_CAP_BYTES = 1024 * 1024;

/** `ESC` + `\n` — Shift+Enter's multiline-without-submit sequence. */
const ESC_NEWLINE = new Uint8Array([0x1b, 0x0a]);
/** `Ctrl+U` — the readline kill-line control byte (⌘/Ctrl+Backspace). */
const KILL_LINE = new Uint8Array([0x15]);

/** The byte-write sink the keymap emits through — supplied by the session manager so
 *  the manual (non-`onData`) emits funnel through the broadcast fan-out (round-2 PR B).
 *  When broadcast is armed the write reaches every visible pane; otherwise just the
 *  owning session, exactly as before. */
export interface EmitBroadcast {
  readonly write: (data: Uint8Array) => void;
  /** Jump the viewport to the previous/next OSC 133 prompt (#405). Injected by the
   *  session manager (which owns the per-session block list); a no-op for a shell that
   *  emits no marks. */
  readonly prompt?: (direction: -1 | 1) => void;
  /** Copy the last command's output to the clipboard (#405). Injected likewise. */
  readonly copyLastOutput?: () => void;
}

/** What the cockpit does with a keydown, decided purely (testable without xterm).
 *  `copy` = copy-if-selection-else-passthrough-SIGINT; the impure handler resolves
 *  the selection. */
export type KeyIntent =
  | 'passthrough'
  | 'swallow'
  | 'copy'
  | 'paste'
  | 'multiline'
  | 'killline'
  | 'prev-prompt'
  | 'next-prompt'
  | 'copy-last-output';

/** The subset of a keyboard event the classifier reads — so it can be exercised
 *  with plain objects in tests. */
export interface KeyEventLike {
  readonly type: string;
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

function isLetter(key: string, letter: string): boolean {
  return key === letter || key === letter.toUpperCase();
}

/** Classify a keydown into a cockpit {@link KeyIntent}. Pure: the platform (mac vs
 *  not) is passed in, and no clipboard / terminal state is read. `keydown`-only —
 *  every other event type passes through untouched. */
export function classifyKeyEvent(e: KeyEventLike, isMac: boolean): KeyIntent {
  if (e.type !== 'keydown') return 'passthrough';
  const primary = isMac ? e.metaKey : e.ctrlKey;

  // OSC 133 shell integration (#405). Checked BEFORE the generic app chords so the
  // copy-last-output chord isn't shadowed by smart-copy.
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && isLetter(e.key, 'o')) return 'copy-last-output';
  if (primary && !e.shiftKey && e.key === 'ArrowUp') return 'prev-prompt';
  if (primary && !e.shiftKey && e.key === 'ArrowDown') return 'next-prompt';

  // App chords handled by React (view/pane/grid) — never forwarded to the PTY.
  // Zoom is ⌘/Ctrl + Shift + E (matches the layout hook's platform-agnostic gate).
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && isLetter(e.key, 'e')) return 'swallow';
  if (primary && !e.shiftKey && (isLetter(e.key, 't') || isLetter(e.key, 'w'))) return 'swallow';
  if (primary && !e.shiftKey && isLetter(e.key, 'f')) return 'swallow';
  // ⌘1..9 selects the Nth tab/pane (#405) — handled by the view's shortcut hook.
  if (primary && !e.shiftKey && /^[1-9]$/.test(e.key)) return 'swallow';

  // Smart copy: primary + C. Selection → copy (swallow); else passthrough so a
  // non-mac Ctrl+C still reaches the shell as SIGINT.
  if (primary && !e.shiftKey && isLetter(e.key, 'c')) return 'copy';

  // Paste: ⌘V on mac; Ctrl+V or Ctrl+Shift+V elsewhere.
  if (isMac) {
    if (e.metaKey && !e.shiftKey && isLetter(e.key, 'v')) return 'paste';
  } else if (e.ctrlKey && isLetter(e.key, 'v')) {
    return 'paste';
  }

  // Shift+Enter → ESC + \n (no primary modifier).
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && e.key === 'Enter') return 'multiline';

  // ⌘/Ctrl + Backspace → kill line.
  if (primary && e.key === 'Backspace') return 'killline';

  return 'passthrough';
}

// --- Paste-cap notifier (non-React → view toast) ---------------------------

type PasteRejectedListener = () => void;
const pasteRejectedListeners = new Set<PasteRejectedListener>();

/** Subscribe to "paste dropped (over the 1 MB cap)" events; returns an unsubscribe.
 *  The Terminal view turns each into a toast. */
export function subscribePasteRejected(fn: PasteRejectedListener): () => void {
  pasteRejectedListeners.add(fn);
  return () => {
    pasteRejectedListeners.delete(fn);
  };
}

function notifyPasteRejected(): void {
  for (const fn of pasteRejectedListeners) fn();
}

async function copySelection(term: Terminal): Promise<void> {
  const selection = term.getSelection();
  if (selection.length === 0) return;
  try {
    await navigator.clipboard.writeText(selection);
  } catch {
    // Clipboard write blocked (permission / non-secure context) — nothing to do;
    // the selection stays visible so the user can copy via the OS menu.
  }
}

async function pasteFromClipboard(term: Terminal): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return; // clipboard read blocked — no-op.
  }
  if (text.length === 0) return;
  // Cap on the ENCODED byte length so multibyte content can't slip past.
  if (new TextEncoder().encode(text).length > PASTE_CAP_BYTES) {
    notifyPasteRejected();
    return;
  }
  // `term.paste` brackets the payload iff the program enabled bracketed paste
  // (`?2004h`), so a multiline paste can't execute line-by-line in a bare shell.
  term.paste(text);
}

/** Install the cockpit keymap on a live terminal. Idempotent per term — xterm keeps
 *  a single custom key-event handler, so re-calling replaces it. `emit.write` is the
 *  byte sink for the manual (non-`onData`) intents, wired by the session manager to
 *  the broadcast fan-out so an armed broadcast reaches every visible pane (round-2
 *  PR B). Paste routes through `term.paste` (which rides `onData`), so it fans out via
 *  the session manager's `onData` path without a second write here. */
export function installKeymap(term: Terminal, emit: EmitBroadcast): void {
  term.attachCustomKeyEventHandler((event) => {
    const intent = classifyKeyEvent(event, isMacPlatform());
    switch (intent) {
      case 'passthrough':
        return true;
      case 'swallow':
        return false;
      case 'copy': {
        if (term.getSelection().length > 0) {
          void copySelection(term);
          return false;
        }
        return true; // no selection → let the shell receive SIGINT.
      }
      case 'paste':
        void pasteFromClipboard(term);
        return false;
      case 'multiline':
        emit.write(ESC_NEWLINE);
        return false;
      case 'killline':
        emit.write(KILL_LINE);
        return false;
      case 'prev-prompt':
        emit.prompt?.(-1);
        return false;
      case 'next-prompt':
        emit.prompt?.(1);
        return false;
      case 'copy-last-output':
        emit.copyLastOutput?.();
        return false;
    }
  });
}
