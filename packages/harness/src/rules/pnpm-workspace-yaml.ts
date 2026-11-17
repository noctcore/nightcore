import { stripYamlComment, unquote } from './yaml-lines.js';

/**
 * A textual reader for the two shapes pnpm-workspace.yaml uses at its top
 * level: a `key: value` scalar and a `key:` block list of `- item` lines.
 * Anything else under a list key is handed back as unreadable, so a rule can
 * report it instead of reading it as empty.
 */

/** One `- item` of a block list, with the comment lines written directly above it (or above the run of items it belongs to). */
export interface IListItem {
  readonly value: string;
  /** The comment block above the item, joined into one line; '' when there is none. */
  readonly reason: string;
}

export interface IWorkspaceList {
  readonly items: readonly IListItem[];
  /** Lines under the key that are neither an item nor a comment, and a flow list written on the key's own line. */
  readonly unreadable: readonly string[];
}

/** The value of a top-level `key: value` line, unquoted and without its comment, or null when the key is not there. */
export function workspaceScalar(text: string, key: string): string | null {
  for (const line of text.split('\n')) {
    if (line.startsWith(`${key}:`)) {
      return unquote(stripYamlComment(line.slice(key.length + 1)));
    }
  }
  return null;
}

/** The `- item` lines of a top-level block list, or null when the key is not there. */
export function workspaceList(text: string, key: string): IWorkspaceList | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return null;

  const items: IListItem[] = [];
  const unreadable: string[] = [];
  const inline = stripYamlComment((lines[start] ?? '').slice(key.length + 1)).trim();
  if (inline !== '') unreadable.push(inline);

  let comment: string[] = [];
  let reason = '';
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    const trimmed = line.trim();
    if (trimmed === '') {
      comment = [];
      reason = '';
      continue;
    }
    if (trimmed.startsWith('#')) {
      comment.push(trimmed.replace(/^#\s?/u, ''));
      continue;
    }
    const item = /^-\s+(.*)$/u.exec(trimmed);
    if (item === null) {
      unreadable.push(trimmed);
      continue;
    }
    if (comment.length > 0) {
      reason = comment.join(' ');
      comment = [];
    }
    items.push({ value: unquote(stripYamlComment(item[1] ?? '')), reason });
  }
  return { items, unreadable };
}
