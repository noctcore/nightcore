/** Inline unified-diff patch renderer for one changed file. */
import { Spinner } from '@/components/ui';

import type { DiffLineKind } from './DiffPatchView.hooks';
import { isBinaryPatch, useDiffLines } from './DiffPatchView.hooks';
import type { DiffPatchViewProps } from './DiffPatchView.types';

/** Per-kind tint for a patch line: green for additions, red for deletions, an
 *  accent for hunk headers (`@@`), muted for file/meta headers, default for
 *  context. Built from the same emerald/red/sky palette the file-list pills use. */
const LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-emerald-500/[0.08] text-emerald-300',
  del: 'bg-red-500/[0.08] text-red-300',
  hunk: 'text-sky-400',
  meta: 'text-muted-foreground',
  context: 'text-foreground',
};

/** The quiet note shown when there is nothing to render as diff lines: the
 *  binary sentinel is surfaced verbatim, everything else reads as an empty diff. */
function emptyNote(patch: string | null): string {
  return isBinaryPatch(patch) ? (patch as string) : 'No textual changes to show.';
}

/** Render a fetched unified-diff patch for one file: a horizontally-scrolling,
 *  height-capped monospace block with per-line coloring (+ green / − red / hunk
 *  accent / headers muted). Shows a spinner while the patch is loading and a
 *  quiet note for an empty or binary patch. Purely presentational — the parent
 *  owns the lazy `worktree_file_diff` fetch that produces `patch`. */
export function DiffPatchView({ patch, loading = false }: DiffPatchViewProps) {
  const lines = useDiffLines(patch);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4 text-muted-foreground">
        <Spinner size={16} />
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <p className="px-5 py-3 font-mono text-[12px] text-muted-foreground">{emptyNote(patch)}</p>
    );
  }

  return (
    // The patch scrolls on BOTH its own axes so a long line never widens the
    // dialog and a large diff never grows the row unbounded (height-capped +
    // vertical scroll). `w-max min-w-full` on the block keeps every row's tint
    // spanning the full scroll width, not just the visible viewport.
    <div className="max-h-[50vh] overflow-auto border-y border-border bg-black/20">
      <pre className="w-max min-w-full font-mono text-[12px] leading-[1.5]">
        {lines.map((line) => (
          <div key={line.id} className={`px-5 ${LINE_CLASS[line.kind]}`}>
            {line.text === '' ? ' ' : line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
