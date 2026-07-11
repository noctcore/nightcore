/** DiffPatchView helpers: parse a raw unified-diff patch into classified lines
 *  for coloring. The parse is memoized in `useDiffLines` so it stays out of the
 *  `.tsx` body (the folder-per-component no-state-in-body rule). The pure
 *  `classifyDiffLine` / `parseDiffLines` are exported for direct unit testing. */
import { useMemo } from 'react';

/** The visual class of one patch line — drives its tint in the view. */
export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context';

/** One parsed patch line: its text + how to color it. `id` is the source index,
 *  stable within a patch (patch strings are immutable), so it keys the list. */
export interface DiffLine {
  id: number;
  text: string;
  kind: DiffLineKind;
}

/** File-header / metadata line prefixes that render muted, NOT as added/removed
 *  content. `+++ `/`--- ` live here deliberately: they start with `+`/`-` but are
 *  headers, so they must be matched BEFORE the `+`/`-` content test below. */
const META_PREFIXES = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  'new file',
  'deleted file',
  'rename ',
  'similarity ',
  'old mode',
  'new mode',
];

/** Whether the raw patch is the binary-file sentinel the backend returns for a
 *  binary blob (`Binary file <path> (not shown)`) — surfaced as a quiet note
 *  rather than parsed into diff lines. */
export function isBinaryPatch(patch: string | null): boolean {
  return patch !== null && patch.startsWith('Binary file ');
}

/** Classify one patch line for coloring. Order matters: the hunk header (`@@`)
 *  and the `+++ `/`--- ` file headers are tested BEFORE the `+`/`-` content check
 *  so a file header is never miscolored as an added/removed line. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  for (const prefix of META_PREFIXES) {
    if (line.startsWith(prefix)) return 'meta';
  }
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

/** Parse a raw unified-diff patch into classified lines. Returns `[]` for a
 *  null / empty / binary patch (the view renders a quiet note for those). A
 *  single trailing newline is trimmed so we don't render a phantom blank final
 *  row. Exported for direct unit testing (no render needed). */
export function parseDiffLines(patch: string | null): DiffLine[] {
  if (patch === null) return [];
  if (patch.trim() === '' || isBinaryPatch(patch)) return [];
  return patch
    .replace(/\n$/, '')
    .split('\n')
    .map((text, id) => ({ id, text, kind: classifyDiffLine(text) }));
}

/** Memoized patch parse for the view — recomputes only when the patch text
 *  changes (each row's patch is fetched once and stays stable). */
export function useDiffLines(patch: string | null): DiffLine[] {
  return useMemo(() => parseDiffLines(patch), [patch]);
}
