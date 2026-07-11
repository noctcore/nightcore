/**
 * Process-title auto-naming for terminal tabs (T11, OSC 0/2). A plain feature-root
 * module (not React state), driven from the session manager's single `onTitleChange`
 * path — xterm surfaces the shell's own window/icon-title escape (`ESC ] 0 ; …` /
 * `ESC ] 2 ; …`) there.
 *
 * WHAT IT DOES: debounces the (potentially chatty) title stream, then applies the
 * shell's title as the tab name with the LOWEST `'processTitle'` precedence. The Rust
 * side enforces precedence under the registry lock — a Manual / Task / AI (`'auto'`)
 * name always wins — and returns the title it ACTUALLY applied (or `null` when
 * refused), so a `claude` / `vim` window title can only ever fill an un-named tab (a
 * better default than the bare cwd leaf), never clobber a chosen name.
 *
 * FREE, no quota: unlike the AI-naming one-shot this makes no model call — it just
 * relays the title the shell already emitted. It is always on (no opt-in setting).
 */
import { setTerminalProcessTitle } from '@/lib/bridge';

/** Settle the (potentially rapid) `onTitleChange` stream before applying — a shell that
 *  retitles on every prompt/keystroke otherwise spams the backend + the tab label. */
export const PROCESS_TITLE_DEBOUNCE_MS = 400;

/** The applier the debounce calls — the real bridge command by default. Overridable
 *  for unit tests so the debounce/dedup logic runs without a real backend (mirrors the
 *  command-capture module's `setTitleSuggester` seam). */
type ProcessTitleApplier = (id: string, title: string) => Promise<string | null>;

interface Pending {
  /** The latest title seen, awaiting the debounce. */
  title: string;
  /** The debounce timer, reset on every title change. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The last title actually sent, so an identical retitle does not re-apply. */
  lastSent: string | null;
}

let applier: ProcessTitleApplier = setTerminalProcessTitle;
const pending = new Map<string, Pending>();
type Listener = (id: string, title: string) => void;
const listeners = new Set<Listener>();

/** Replace the process-title applier (test seam). Pass `null` to restore the bridge. */
export function setProcessTitleApplier(fn: ProcessTitleApplier | null): void {
  applier = fn ?? setTerminalProcessTitle;
}

/** Subscribe to APPLIED process titles (only names that actually stuck server-side).
 *  The view updates the session's title + source on each notification. */
export function subscribeProcessTitle(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Record a raw `onTitleChange` for a session (called from the session manager). Blank
 *  titles are ignored; the rest are debounced then applied with `'processTitle'`
 *  precedence. */
export function recordProcessTitle(id: string, rawTitle: string): void {
  const title = rawTitle.trim();
  if (title === '') return;
  let p = pending.get(id);
  if (p === undefined) {
    p = { title, timer: null, lastSent: null };
    pending.set(id, p);
  }
  p.title = title;
  if (p.timer !== null) clearTimeout(p.timer);
  p.timer = setTimeout(() => fire(id), PROCESS_TITLE_DEBOUNCE_MS);
}

function fire(id: string): void {
  const p = pending.get(id);
  if (p === undefined) return;
  p.timer = null;
  const title = p.title;
  // An identical retitle (a shell that re-emits the same window title every prompt)
  // is skipped — the server would apply the same value anyway.
  if (title === p.lastSent) return;
  p.lastSent = title;
  void applier(id, title)
    .then((applied) => {
      // The server returns the title only if the ProcessTitle write actually landed
      // (a Manual/Task/AI name refuses it → null), so we reflect only names that stuck.
      if (applied !== null && applied !== '') {
        for (const fn of listeners) fn(id, applied);
      }
    })
    .catch(() => {
      // Fail-soft: a failed apply keeps the current title, never errors the UI.
    });
}

/** Drop a session's pending process-title state (on close). Idempotent. */
export function forgetProcessTitle(id: string): void {
  const p = pending.get(id);
  if (p?.timer != null) clearTimeout(p.timer);
  pending.delete(id);
}
