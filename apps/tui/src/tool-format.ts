/**
 * Pure formatting helpers that turn a raw tool-use `input` object into the bits
 * the transcript renders: a one-line summary (glyph + label + primary target)
 * and, for edit-shaped tools, a structured diff/preview block.
 *
 * Kept free of any OpenTUI / React import so it is trivially unit-testable and so
 * `StreamView` stays a thin presenter over these results.
 */

export interface ToolSummary {
  /** A short leading glyph hinting the tool's nature (edit, run, read, search). */
  glyph: string;
  /** Human label — the tool name, lightly normalized. */
  label: string;
  /** The primary argument: a file path, a shell command, a search pattern. */
  target: string;
  /** Optional secondary detail shown dimmed (e.g. a Bash command description). */
  detail?: string;
}

/** A removed/added line pair for an edit, ready to render as a mini-diff. */
export interface EditPreview {
  removed: string[];
  added: string[];
  /** Lines elided past the display cap, so the view can show `…(+N more)`. */
  truncated: number;
}

const MAX_TARGET = 100;
const MAX_DIFF_LINES = 10;

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' ? v : undefined;
}

/** Show the last few path segments so deep paths stay readable in a narrow pane. */
function shortenPath(path: string): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join('/')}`;
}

function clip(text: string, max = MAX_TARGET): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Summarize a tool call for its header line. Recognizes the common Claude Code
 * tools (Edit/Write/Read/Bash/Grep/Glob/Task) plus the nightcore MCP tools,
 * which key paths as `path` rather than `file_path`. Falls back to compact JSON
 * for anything unrecognized so no tool ever renders blank.
 */
export function summarizeTool(
  toolName: string,
  input: Record<string, unknown>,
): ToolSummary {
  const file = str(input, 'file_path') ?? str(input, 'path');
  const base = toolName.replace(/^mcp__[^_]*__/, '');

  switch (base) {
    case 'Edit':
    case 'MultiEdit':
    case 'edit_file':
      return { glyph: '✎', label: 'Edit', target: file ? shortenPath(file) : '' };
    case 'Write':
    case 'write_file':
      return { glyph: '✎', label: 'Write', target: file ? shortenPath(file) : '' };
    case 'Read':
    case 'read_file': {
      const range =
        typeof input.offset === 'number'
          ? `:${String(input.offset)}${typeof input.limit === 'number' ? `+${String(input.limit)}` : ''}`
          : '';
      return {
        glyph: '◇',
        label: 'Read',
        target: file ? `${shortenPath(file)}${range}` : '',
      };
    }
    case 'Bash':
    case 'run_command': {
      const cmd = str(input, 'command') ?? '';
      const desc = str(input, 'description');
      return {
        glyph: '⚙',
        label: 'Bash',
        target: clip(cmd),
        ...(desc !== undefined ? { detail: clip(desc, 60) } : {}),
      };
    }
    case 'Grep':
    case 'grep': {
      const pat = str(input, 'pattern') ?? '';
      const where = str(input, 'glob') ?? str(input, 'path');
      return {
        glyph: '⌕',
        label: 'Grep',
        target: clip(pat, 60),
        ...(where !== undefined ? { detail: shortenPath(where) } : {}),
      };
    }
    case 'Glob':
    case 'glob':
    case 'list_dir':
      return {
        glyph: '⌕',
        label: base === 'list_dir' ? 'List' : 'Glob',
        target: clip(str(input, 'pattern') ?? file ?? ''),
      };
    case 'Task':
      return {
        glyph: '◆',
        label: 'Task',
        target: clip(str(input, 'description') ?? str(input, 'subagent_type') ?? ''),
      };
    default:
      return { glyph: '⚙', label: base, target: clip(compactJson(input)) };
  }
}

/**
 * Build a removed/added line preview for an edit-shaped tool. Returns null when
 * the input carries no `old_string`/`new_string` pair (e.g. Write, or an MCP
 * variant that only sends the final content). Blank old/new sides are dropped so
 * a pure insertion shows only `+` lines and a pure deletion only `-` lines.
 */
export function editPreview(
  input: Record<string, unknown>,
): EditPreview | null {
  const oldStr = str(input, 'old_string');
  const newStr = str(input, 'new_string');
  if (oldStr === undefined && newStr === undefined) return null;

  const removed = splitLines(oldStr);
  const added = splitLines(newStr);
  const total = removed.length + added.length;
  if (total === 0) return null;

  if (total <= MAX_DIFF_LINES) return { removed, added, truncated: 0 };

  // Keep the head of each side proportionally so both show some context.
  const keepRemoved = Math.min(removed.length, Math.ceil(MAX_DIFF_LINES / 2));
  const keepAdded = Math.min(added.length, MAX_DIFF_LINES - keepRemoved);
  return {
    removed: removed.slice(0, keepRemoved),
    added: added.slice(0, keepAdded),
    truncated: total - keepRemoved - keepAdded,
  };
}

function splitLines(text: string | undefined): string[] {
  if (text === undefined || text.length === 0) return [];
  return text.replace(/\n$/, '').split('\n');
}

/** Compact one-line JSON, length-capped — the universal fallback target. */
export function compactJson(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}
