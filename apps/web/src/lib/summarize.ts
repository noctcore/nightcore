/** Concise one-line summaries of a tool's `input` for the UI (M4.7 §B). Shared by
 *  the interactive permission prompt and the TaskDetail tool list so both render
 *  the telling argument (a path/pattern/command) instead of just the tool name.
 *  Pure — never logs the input (it may carry paths/commands surfaced only to the
 *  UI; the core keeps its own log discipline). */

/** Truncate `text` to `max` chars with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Render a tool input object as a compact one-line summary. Prefers the most
 *  telling field (a shell `command`, a file `path`/`file_path`, a `url`, or a
 *  `pattern`); falls back to a truncated JSON of the whole input. */
export function summarizeInput(input: Record<string, unknown>): string {
  const PREFERRED = ['command', 'file_path', 'path', 'url', 'pattern'];
  for (const key of PREFERRED) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return truncate(value, 160);
    }
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return '(no input)';
  return truncate(JSON.stringify(input), 160);
}
