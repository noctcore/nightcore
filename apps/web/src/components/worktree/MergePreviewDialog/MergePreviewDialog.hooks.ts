/** MergePreviewDialog helpers: the per-status banner chrome (label, tint, glyph).
 *  Pure presentation derivation — no React state, mirroring the folder-per-
 *  component convention where this view's logic travels alongside it. */
import { AlertIcon, CheckIcon } from '@/components/ui';
import type { MergePreview, MergePreviewStatus } from '@/lib/bridge';

/** Banner chrome per merge status — tinted border/background/text built from the
 *  app's semantic tokens (success/warning/destructive). */
const STATUS_BANNER: Record<MergePreviewStatus, string> = {
  ready: 'border-success/40 bg-success/[0.12] text-success',
  upToDate: 'border-border bg-white/[0.02] text-muted-foreground',
  diverged: 'border-warning/40 bg-warning/[0.12] text-warning',
  conflicts: 'border-destructive/40 bg-destructive/[0.12] text-destructive',
};

/** The human-readable banner label for a status — diverged/conflicts fold in the
 *  relevant count. */
function statusLabel(preview: MergePreview): string {
  switch (preview.status) {
    case 'ready':
      return 'Ready to merge';
    case 'upToDate':
      return 'Already up to date';
    case 'diverged':
      return `Branch diverged (${preview.behind} behind)`;
    case 'conflicts': {
      const n = preview.conflictFiles.length;
      return `${n} conflict${n === 1 ? '' : 's'} — resolve before merging`;
    }
  }
}

/** The status banner's label, tint classes, and glyph — clean (check) for
 *  ready/up-to-date, alert (triangle) for diverged/conflicts. */
export function mergeStatusBanner(preview: MergePreview): {
  label: string;
  className: string;
  Icon: typeof CheckIcon;
} {
  const clean = preview.status === 'ready' || preview.status === 'upToDate';
  return {
    label: statusLabel(preview),
    className: STATUS_BANNER[preview.status],
    Icon: clean ? CheckIcon : AlertIcon,
  };
}

/** Whether the Merge action should be blocked given the current preview/flags:
 *  while the preview or merge is in flight, before a preview arrives, and for the
 *  two non-mergeable statuses (already up to date, or unresolved conflicts). */
export function isMergeBlocked(
  preview: MergePreview | null,
  loading: boolean,
  merging: boolean,
): boolean {
  return (
    loading ||
    merging ||
    preview === null ||
    preview.status === 'conflicts' ||
    preview.status === 'upToDate'
  );
}
