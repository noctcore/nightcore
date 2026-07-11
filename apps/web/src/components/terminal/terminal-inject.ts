/**
 * Pure composition helpers for task→terminal injection and the `claude` launch/resume
 * commands (cockpit spec PR 4, decisions 2 & 3). No React, no bridge — the orchestration
 * hook (`terminal-tasks.ts`) frames these and writes them into the PTY via
 * `terminal_write`. Kept pure so every mechanic (bracketed-paste framing, no-trailing-
 * newline, POSIX shell-escaping, the on-disk task-file path) is unit-testable.
 */
import type { Task } from '@/lib/bridge';

/** Bracketed-paste framing (spec §4): a program in `?2004h` mode (interactive zsh/bash,
 *  the claude TUI) treats everything between these markers as LITERAL input, so embedded
 *  newlines in a multiline task prompt don't execute line-by-line in a bare shell. */
export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

/** Whether a path looks Windows-shaped (verbatim prefix, drive letter, or backslash-only)
 *  so {@link taskFilePath} joins with the right separator for the "exact on-disk path". */
function isWindowsPath(path: string): boolean {
  if (/^\\\\\?\\/.test(path) || /^[A-Za-z]:[\\/]/.test(path)) return true;
  return path.includes('\\') && !path.includes('/');
}

/** The on-disk path of a task's JSON record: `<projectPath>/.nightcore/tasks/<id>.json`
 *  (the verified store convention). Joined with the project path's own separator so the
 *  injected reference is the real path on either OS. */
export function taskFilePath(projectPath: string, taskId: string): string {
  const sep = isWindowsPath(projectPath) ? '\\' : '/';
  const trimmed = projectPath.replace(/[/\\]+$/, '');
  return [trimmed, '.nightcore', 'tasks', `${taskId}.json`].join(sep);
}

/** Compose the task-context text injected into the terminal (decision 2): the task
 *  title, a blank line, the description (when present) + a blank line, then the
 *  `Task file:` line pointing at the on-disk JSON. Raw text — the caller frames it in
 *  bracketed paste and writes it WITHOUT a trailing newline (the user presses Enter). */
export function composeTaskContext(task: Task, projectPath: string | null): string {
  const lines: string[] = [task.title.trim() || 'Untitled task', ''];
  const description = task.description.trim();
  if (description !== '') {
    lines.push(description, '');
  }
  if (projectPath !== null) {
    lines.push(`Task file: ${taskFilePath(projectPath, task.id)}`);
  }
  return lines.join('\n');
}

/** Wrap `text` in bracketed-paste markers (spec §4). No trailing newline — decision 2
 *  leaves the Enter to the user, so a multiline prompt can be reviewed before it runs. */
export function frameBracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/** Single-quote a value for a POSIX shell, escaping embedded single quotes
 *  (`'` → `'\''`). Used to safely quote a cwd in the composed `cd … && claude`. */
export function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The lower-cased file stem of a shell path (host-independent — splits on BOTH
 *  separators, drops a single trailing extension). Mirrors the Rust `shell_stem`. */
function shellStem(shell: string): string {
  const base = shell.split(/[/\\]/).pop() ?? shell;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.toLowerCase();
}

/** Known POSIX shells that understand `&&` + single-quote escaping — the composed
 *  launch is gated to these in v1 (decision 3). Mirrors the Rust `is_posix_shell`. */
const POSIX_SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'ash',
  'fish',
  'tcsh',
  'csh',
]);

/** Whether a session's shell can run the composed POSIX launch. A PowerShell / cmd
 *  session hides the Launch-Claude button in v1 (it would need `;` + different quoting). */
export function isPosixShell(shell: string): boolean {
  return POSIX_SHELLS.has(shellStem(shell));
}

/** Compose the one-click "Launch Claude" command (decision 3): `cd <escaped cwd> &&
 *  claude`, plus `--dangerously-skip-permissions` when YOLO is on (decision 3/4e). Ends
 *  with `\r` — this one is meant to EXECUTE immediately (unlike the task injection). */
export function composeClaudeLaunch(cwd: string, opts: { yolo: boolean }): string {
  const flags = opts.yolo ? ' --dangerously-skip-permissions' : '';
  return `cd ${shellQuotePosix(cwd)} && claude${flags}\r`;
}

/** Compose the "Resume" command for a restored/fresh shell (decision 3): `cd <escaped
 *  cwd> && claude --continue` — `--continue` resumes the most-recent session in that
 *  cwd (no fragile `--resume <id>`). YOLO appends the skip-permissions flag too. */
export function composeClaudeResume(cwd: string, opts: { yolo: boolean }): string {
  const flags = opts.yolo ? ' --dangerously-skip-permissions' : '';
  return `cd ${shellQuotePosix(cwd)} && claude --continue${flags}\r`;
}
