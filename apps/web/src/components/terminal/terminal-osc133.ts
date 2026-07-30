/**
 * OSC 133 shell integration for the Terminal cockpit (#405).
 *
 * OSC 133 is the field's converged plumbing for "where did a command start, where did
 * its output start, and what did it exit with" — emitted by the shell itself (VS Code,
 * iTerm2, WezTerm, Kitty, Ghostty and Windows Terminal all consume the same four
 * marks). Parsing it turns an undifferentiated byte stream into a list of COMMAND
 * BLOCKS, which is what unlocks exit-status decorations, prompt navigation,
 * copy-last-output, and an honest "this took a while" completion signal.
 *
 *   OSC 133 ; A ST          prompt start
 *   OSC 133 ; B ST          command (user input) start
 *   OSC 133 ; C ST          command output start — the command is now RUNNING
 *   OSC 133 ; D [; code] ST command finished, optionally with its exit status
 *
 * Any of them may carry extra `;k=v` parameters (aid, cl, …) — the leading letter is
 * the only part this parser trusts, and an unrecognized letter is consumed silently
 * rather than warned about.
 *
 * ## Seam
 * OUTPUT-SIDE ONLY, exactly like `terminal-attention`'s OSC 9/99/777 parser: this
 * module reads bytes the shell EMITS and never writes to the PTY, so the terminal's
 * USER-ONLY constraint is untouched. It also never inspects command TEXT for meaning —
 * the marks are structural, not a busy/idle content heuristic.
 *
 * ## Why module-level
 * The session manager's xterm instances outlive the routed view's remounts, so their
 * block lists must too. State is keyed by session id and dropped by
 * {@link forgetOsc133} on close.
 *
 * A shell that emits nothing degrades to exactly today's behavior: no blocks, no
 * decorations, and the nav/copy actions are inert no-ops.
 */
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';

import { signalCompletion } from './terminal-attention';

/** A command that ran long enough that the user has probably looked away — the
 *  "notify if it took a while" threshold. */
export const SLOW_COMMAND_MS = 5_000;

/** Blocks retained per session. Bounds memory on a long-lived shell; the nav/copy
 *  actions only ever reach for recent blocks anyway. */
const MAX_BLOCKS = 256;

/** One shell command's span, assembled across the four marks. */
export interface CommandBlock {
  /** Absolute buffer line of the prompt (mark A) — the prompt-navigation target. */
  readonly promptLine: number;
  /** Absolute buffer line where output began (mark C), or `null` if it never ran. */
  outputLine: number | null;
  /** Absolute buffer line where output ended (mark D), or `null` while running. */
  endLine: number | null;
  /** The command's exit status, or `null` when it is still running / the shell
   *  reported `D` without a code. */
  exitCode: number | null;
  /** Epoch-ms the command started running (mark C). */
  startedAt: number | null;
  /** Wall-clock run time, once mark D lands. */
  durationMs: number | null;
}

interface SessionState {
  readonly blocks: CommandBlock[];
  /** The block awaiting its `D`, i.e. the running command. */
  running: CommandBlock | null;
  /** Every decoration handle, disposed with the session. */
  readonly decorations: IDecoration[];
}

const sessions = new Map<string, SessionState>();

function stateFor(id: string): SessionState {
  let state = sessions.get(id);
  if (state === undefined) {
    state = { blocks: [], running: null, decorations: [] };
    sessions.set(id, state);
  }
  return state;
}

/** The absolute (scrollback-inclusive) buffer line the cursor sits on. Marks arrive
 *  inline with output, so "where the cursor is now" is where the mark belongs. */
function cursorLine(term: Terminal): number {
  const buffer = term.buffer.active;
  return buffer.baseY + buffer.cursorY;
}

/** Parse an OSC 133 payload into its mark letter + optional exit code. Returns `null`
 *  for a payload this parser does not model (still consumed, never warned). */
export function parseOsc133(data: string): { mark: string; exitCode: number | null } | null {
  const parts = data.split(';');
  const mark = (parts[0] ?? '').trim().toUpperCase();
  if (mark !== 'A' && mark !== 'B' && mark !== 'C' && mark !== 'D') return null;
  // `D` may carry a status as its first extra field; anything non-numeric (a `k=v`
  // parameter) means "finished, status unknown" rather than a bogus 0.
  const raw = parts[1]?.trim() ?? '';
  const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
  return { mark, exitCode: mark === 'D' ? parsed : null };
}

// --- Read side (the nav / copy / status actions) ----------------------------

/** Every completed-or-running block for a session, oldest first. `[]` for an unknown
 *  id or a shell with no OSC 133 support. */
export function commandBlocks(id: string): readonly CommandBlock[] {
  return sessions.get(id)?.blocks ?? [];
}

/** The prompt line to jump to, moving `direction` (-1 previous / +1 next) from
 *  `fromLine`. `null` when there is nothing in that direction — the caller then leaves
 *  the viewport alone rather than snapping to an edge. Pure over the block list so
 *  the navigation is unit-testable without a live terminal. */
export function adjacentPromptLine(
  blocks: readonly CommandBlock[],
  fromLine: number,
  direction: -1 | 1,
): number | null {
  const lines = blocks.map((b) => b.promptLine);
  if (direction === -1) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line !== undefined && line < fromLine) return line;
    }
    return null;
  }
  for (const line of lines) {
    if (line > fromLine) return line;
  }
  return null;
}

/** Scroll a session's terminal to the previous/next prompt (⌘↑ / ⌘↓). A no-op when
 *  the shell emits no OSC 133 marks or there is no prompt in that direction. Returns
 *  whether it moved, so a caller can decide whether to fall through to the shell. */
export function scrollToAdjacentPrompt(term: Terminal, id: string, direction: -1 | 1): boolean {
  const target = adjacentPromptLine(commandBlocks(id), term.buffer.active.viewportY, direction);
  if (target === null) return false;
  term.scrollToLine(target);
  return true;
}

/** Read the plain text of a completed block's OUTPUT (the span between marks C and D)
 *  out of a terminal's buffer. Pure-ish (reads only the buffer) and exported so the
 *  copy action is testable against a fabricated terminal. Trailing blank lines are
 *  trimmed — the block's last line is usually the next prompt's blank. */
export function readBlockOutput(term: Terminal, block: CommandBlock): string {
  if (block.outputLine === null) return '';
  const end = block.endLine ?? term.buffer.active.baseY + term.buffer.active.cursorY;
  const lines: string[] = [];
  for (let line = block.outputLine; line < end; line += 1) {
    lines.push(term.buffer.active.getLine(line)?.translateToString(true) ?? '');
  }
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  return lines.join('\n');
}

/** The most recent block that actually produced output — the copy-last-output target.
 *  Prefers a FINISHED block so ⌘⇧O during a long build copies the previous result
 *  rather than a half-written one. `null` when there is nothing to copy. */
export function lastOutputBlock(id: string): CommandBlock | null {
  const blocks = commandBlocks(id);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block !== undefined && block.outputLine !== null && block.endLine !== null) return block;
  }
  return null;
}

/** Copy the last command's output to the clipboard (⌘⇧O). Resolves to the number of
 *  characters copied — `0` when there is no completed block, the block was silent, or
 *  the clipboard write was blocked — so the caller can toast honestly instead of
 *  claiming a copy that did not happen. */
export async function copyLastOutput(term: Terminal, id: string): Promise<number> {
  const block = lastOutputBlock(id);
  if (block === null) return 0;
  const text = readBlockOutput(term, block);
  if (text.length === 0) return 0;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return 0; // clipboard blocked (permission / non-secure context)
  }
  return text.length;
}

// --- Write side (the parser + its decorations) ------------------------------

/** Paint the exit-status gutter bar for a finished block. Green for `0`, destructive
 *  otherwise; nothing at all when the shell reported no status (an honest blank beats
 *  a green bar that means "we don't know"). */
function decorateExit(term: Terminal, state: SessionState, marker: IMarker, code: number): void {
  const decoration = term.registerDecoration({ marker, x: 0, width: 1 });
  if (decoration === undefined) return;
  state.decorations.push(decoration);
  decoration.onRender((element) => {
    element.style.backgroundColor = code === 0 ? 'var(--nc-success)' : 'var(--nc-destructive)';
    element.style.opacity = code === 0 ? '0.55' : '0.9';
    element.style.width = '2px';
    element.title = code === 0 ? 'Exited 0' : `Exited ${code}`;
  });
}

/** Apply one parsed mark to a session's block list. Split from the handler so the
 *  state machine is unit-testable without an xterm; `decorate` is injected. */
function applyMark(
  state: SessionState,
  mark: string,
  exitCode: number | null,
  line: number,
  now: number,
  decorate: (block: CommandBlock, code: number) => void,
): void {
  switch (mark) {
    case 'A': {
      // A prompt with no intervening command means the previous block never ran
      // (the user pressed Enter on an empty line, or ^C'd); it stays in the list
      // with a null exit code, which every read path treats as "unknown".
      const block: CommandBlock = {
        promptLine: line,
        outputLine: null,
        endLine: null,
        exitCode: null,
        startedAt: null,
        durationMs: null,
      };
      state.blocks.push(block);
      if (state.blocks.length > MAX_BLOCKS) state.blocks.shift();
      state.running = null;
      break;
    }
    case 'B':
      break; // input start — no state of its own; `C` is what makes a block running.
    case 'C': {
      const block = state.blocks.at(-1);
      if (block === undefined) break;
      block.outputLine = line;
      block.startedAt = now;
      state.running = block;
      break;
    }
    case 'D': {
      const block = state.running ?? state.blocks.at(-1);
      if (block === undefined) break;
      block.endLine = line;
      block.exitCode = exitCode;
      block.durationMs = block.startedAt === null ? null : now - block.startedAt;
      state.running = null;
      if (exitCode !== null) decorate(block, exitCode);
      break;
    }
  }
}

// --- Copy-last-output notifier (non-React → view toast) --------------------

type CopyOutputListener = (chars: number) => void;
const copyOutputListeners = new Set<CopyOutputListener>();

/** Subscribe to ⌘⇧O copy-last-output results; returns an unsubscribe. The Terminal
 *  view turns each into a toast — including the `0` case, which is the honest "there
 *  was nothing to copy" (this shell emits no OSC 133 marks, or the command was silent)
 *  rather than a dead shortcut the user has to guess about. */
export function subscribeCopyLastOutput(fn: CopyOutputListener): () => void {
  copyOutputListeners.add(fn);
  return () => {
    copyOutputListeners.delete(fn);
  };
}

/** The keymap actions a session's OSC 133 marks power (#405), handed to `installKeymap`
 *  by the session manager. Both are inert for a shell that emits no marks. */
export interface Osc133Actions {
  readonly prompt: (direction: -1 | 1) => void;
  readonly copyLastOutput: () => void;
}

/**
 * Register the OSC 133 handler on a session's xterm and return the keymap actions it
 * powers. Assembles command blocks, paints exit-status gutter decorations, and raises
 * the shared completion signal for a command that ran longer than
 * {@link SLOW_COMMAND_MS} — which reuses the existing attention +
 * desktop-notification plumbing, so it obeys the same off-screen / unfocused / setting
 * gating as an OSC 9 or a BEL and never nags about something the user is watching.
 *
 * The handler disposes with `term.dispose()`; {@link forgetOsc133} drops the blocks
 * and their decorations.
 */
export function installOsc133(term: Terminal, id: string): Osc133Actions {
  const state = stateFor(id);
  term.parser.registerOscHandler(133, (data) => {
    const parsed = parseOsc133(data);
    // `true` = handled either way, so an unmodelled sub-mark doesn't produce an
    // unknown-OSC warning or leak the escape into the visible buffer.
    if (parsed === null) return true;
    const line = cursorLine(term);
    applyMark(state, parsed.mark, parsed.exitCode, line, Date.now(), (block, code) => {
      const marker = term.registerMarker(block.promptLine - line);
      if (marker !== undefined) decorateExit(term, state, marker, code);
    });
    if (parsed.mark === 'D') {
      const finished = state.blocks.at(-1);
      if (finished !== undefined && (finished.durationMs ?? 0) > SLOW_COMMAND_MS) {
        signalCompletion(id);
      }
    }
    return true;
  });
  return {
    prompt: (direction) => void scrollToAdjacentPrompt(term, id, direction),
    copyLastOutput: () => {
      void copyLastOutput(term, id).then((chars) => {
        for (const fn of copyOutputListeners) fn(chars);
      });
    },
  };
}

/** Drop a session's block list + dispose its decorations (on close). Idempotent. */
export function forgetOsc133(id: string): void {
  const state = sessions.get(id);
  if (state === undefined) return;
  for (const decoration of state.decorations) decoration.dispose();
  sessions.delete(id);
}

/** Test-only: clear every session's blocks so cases don't leak module state. */
export function resetOsc133ForTest(): void {
  sessions.clear();
}

/** Test-only seam: feed marks without an xterm, so the block state machine can be
 *  exercised directly. Mirrors what {@link installOsc133}'s handler does. */
export function applyOsc133ForTest(
  id: string,
  data: string,
  line: number,
  now = Date.now(),
): void {
  const parsed = parseOsc133(data);
  if (parsed === null) return;
  applyMark(stateFor(id), parsed.mark, parsed.exitCode, line, now, () => {});
}
