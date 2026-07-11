/**
 * Per-session command capture for AI tab auto-naming (build spec — terminal round 2,
 * PR A). A plain feature-root module (not React state), driven from the session
 * manager's single input path (`attachSession`'s `term.onData`).
 *
 * WHAT IT DOES: reconstructs the typed command line from raw `onData` keystrokes
 * (best-effort — handles backspace, ignores escape/arrow sequences), skiplists trivial
 * commands (`cd`/`ls`/`git`/…), and after ~1.5s of typing idle asks the Rust
 * `terminal_suggest_title` command (a sandboxed `claude -p` haiku one-shot) for a 2–3
 * word tab title — ONCE per idle period, never twice for the same command. The Rust
 * side applies the name with `Auto` precedence GUARDED under the registry lock, so a
 * manual rename or a linked task's title always wins; this module just triggers it and
 * relays the applied title to subscribers.
 *
 * GATING: nothing is buffered unless {@link setAiNamingEnabled} is on (the opt-in
 * Settings flag) AND the session isn't title-locked ({@link lockSessionTitle}, called
 * for every manual/task rename — no point capturing for a title AI can never take).
 * The Rust command re-checks both (defense in depth), so this is an optimization.
 *
 * LIMITATION (§9l): the line reconstruction is lenient, not a full shell-line editor —
 * a control-sequence-heavy edit (reverse-search, multi-line paste) yields a weaker
 * command string, and thus a weaker title, but NEVER an error. Naming is fail-soft.
 */
import { suggestTerminalTitle } from '@/lib/bridge';

/** Idle (no further keystrokes) after a non-trivial command before we suggest a title.
 *  ~1.5s so a fast follow-up command supersedes the previous one's naming. */
export const IDLE_DEBOUNCE_MS = 1_500;

/** Trivial commands whose first token never warrants renaming a tab (case-insensitive).
 *  A skiplisted or empty line does not trigger naming. */
const SKIP_COMMANDS = new Set([
  'cd',
  'ls',
  'la',
  'll',
  'pwd',
  'clear',
  'cls',
  'exit',
  'git',
  'q',
  'vi',
  'vim',
  'nano',
  'cat',
  'echo',
  'which',
  'env',
  'history',
]);

/** The suggester the debounce trigger calls — the real bridge command by default.
 *  Overridable via {@link setTitleSuggester} so unit tests exercise the capture /
 *  debounce / once-per-period logic without a real `claude` (mirrors the session
 *  manager's `setWebglLoader` seam). */
type TitleSuggester = (id: string, command: string) => Promise<string | null>;

/** Per-session capture state (module-level, never React — survives the view's remounts
 *  exactly like the session manager's instance cache). */
interface Capture {
  /** The reconstructed current line (before Enter). */
  buffer: string;
  /** True while consuming an ANSI escape sequence (arrow/home/function keys). */
  escaping: boolean;
  /** The last finalized NON-TRIVIAL command awaiting the idle debounce, or `null`. */
  pending: string | null;
  /** The idle-debounce timer, reset on every keystroke. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The last command a suggestion actually fired for — so an identical command does
   *  not re-suggest until a different non-trivial command intervenes. */
  lastTriggered: string | null;
}

let aiNamingEnabled = false;
let suggester: TitleSuggester = suggestTerminalTitle;
const captures = new Map<string, Capture>();
/** Sessions whose title is Manual/Task-locked — capture is skipped for them. */
const lockedTitles = new Set<string>();
type SuggestionListener = (id: string, title: string) => void;
const suggestionListeners = new Set<SuggestionListener>();

/** Enable/disable the whole capture layer (the opt-in `terminal_ai_naming` Setting).
 *  Turning it off clears every pending timer + buffer so no late suggestion fires. */
export function setAiNamingEnabled(on: boolean): void {
  aiNamingEnabled = on;
  if (!on) {
    for (const cap of captures.values()) {
      if (cap.timer !== null) clearTimeout(cap.timer);
    }
    captures.clear();
  }
}

/** Replace the title suggester (test seam). Pass `null` to restore the real bridge. */
export function setTitleSuggester(fn: TitleSuggester | null): void {
  suggester = fn ?? suggestTerminalTitle;
}

/** Subscribe to applied AI titles. The view updates the session's title + source on
 *  each notification. Returns an unsubscribe. */
export function subscribeTitleSuggestions(fn: SuggestionListener): () => void {
  suggestionListeners.add(fn);
  return () => {
    suggestionListeners.delete(fn);
  };
}

/** Mark a session's title Manual/Task-locked (a manual inline rename or a linked
 *  task's auto-take): capture stops for it and any in-flight debounce is cancelled, so
 *  the AI never even asks about a title it could not take. */
export function lockSessionTitle(id: string): void {
  lockedTitles.add(id);
  const cap = captures.get(id);
  if (cap !== undefined) {
    if (cap.timer !== null) clearTimeout(cap.timer);
    captures.delete(id);
  }
}

/** Drop a session's capture state + lock (on close). Idempotent. */
export function forgetCommandCapture(id: string): void {
  const cap = captures.get(id);
  if (cap?.timer != null) clearTimeout(cap.timer);
  captures.delete(id);
  lockedTitles.delete(id);
}

/** Whether a finalized command line is too trivial to name a tab after: empty, a
 *  skiplisted first token, or a bare path (no command word). Pure + unit-tested. */
export function isSkiplistedCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === '') return true;
  const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (SKIP_COMMANDS.has(first)) return true;
  // A bare path with no command word — `cd`-style navigation, not a runnable command.
  if (!/\s/.test(trimmed) && /^(\.{0,2}\/|~)/.test(trimmed)) return true;
  return false;
}

/** Record one raw `onData` batch for a session (called from `attachSession`). No-op
 *  when naming is off or the session's title is locked (nothing to gain). */
export function recordCommandInput(id: string, data: string): void {
  if (!aiNamingEnabled || lockedTitles.has(id)) return;
  const cap = getOrCreate(id);
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (cap.escaping) {
      // A CSI/SS3 sequence ends on a final byte (0x40–0x7e), but the intro chars `[`
      // and `O` that immediately follow ESC are in that range — don't terminate on them.
      if (code >= 0x40 && code <= 0x7e && ch !== '[' && ch !== 'O') cap.escaping = false;
      continue;
    }
    if (ch === '\x1b') {
      cap.escaping = true;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      finalizeLine(cap);
      continue;
    }
    if (ch === '\x7f' || ch === '\b') {
      cap.buffer = cap.buffer.slice(0, -1);
      continue;
    }
    // Skip other control bytes (Ctrl-C, tab-completion triggers, …).
    if (code < 0x20) continue;
    cap.buffer += ch;
  }
  // (Re)arm the idle debounce on ANY input, but only while a non-trivial command is
  // pending — so the suggestion fires ~1.5s after the user stops typing.
  armDebounce(id, cap);
}

function getOrCreate(id: string): Capture {
  let cap = captures.get(id);
  if (cap === undefined) {
    cap = { buffer: '', escaping: false, pending: null, timer: null, lastTriggered: null };
    captures.set(id, cap);
  }
  return cap;
}

/** Finalize the current line on Enter: a non-trivial command becomes the pending
 *  candidate; a trivial/empty line is discarded (leaving any prior candidate intact). */
function finalizeLine(cap: Capture): void {
  const cmd = cap.buffer.trim();
  cap.buffer = '';
  if (isSkiplistedCommand(cmd)) return;
  cap.pending = cmd;
}

function armDebounce(id: string, cap: Capture): void {
  if (cap.pending === null) return;
  if (cap.timer !== null) clearTimeout(cap.timer);
  cap.timer = setTimeout(() => fire(id), IDLE_DEBOUNCE_MS);
}

/** The idle debounce elapsed: suggest a title for the pending command, once per period. */
function fire(id: string): void {
  const cap = captures.get(id);
  if (cap === undefined) return;
  cap.timer = null;
  const cmd = cap.pending;
  cap.pending = null;
  if (cmd === null) return;
  // A manual/task rename may have landed during the idle wait; and never re-suggest
  // the identical command (the Rust side also guards, but skip the round-trip).
  if (lockedTitles.has(id) || cmd === cap.lastTriggered) return;
  cap.lastTriggered = cmd;
  void suggester(id, cmd)
    .then((title) => {
      if (title !== null && title !== '') notifySuggestion(id, title);
    })
    .catch(() => {
      // Fail-soft: a failed suggestion keeps the current title, never errors the UI.
    });
}

function notifySuggestion(id: string, title: string): void {
  for (const fn of suggestionListeners) fn(id, title);
}
