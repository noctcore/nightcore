/** DiffViewDialog helpers: the per-status pill presentation. */
import type { DiffStatus } from '@/lib/bridge';

/** Presentation for a diff status pill: the one-letter glyph, an accessible
 *  label (surfaced via `title`), and the tint classes. */
export interface DiffStatusMeta {
  /** Single-letter glyph shown in the pill (A/M/D/R/U). */
  letter: string;
  /** Human label for the status, used as the pill's `title`. */
  label: string;
  /** Tailwind tint classes (background + text) for the pill. */
  pill: string;
}

const STATUS_META: Record<DiffStatus, DiffStatusMeta> = {
  added: { letter: 'A', label: 'Added', pill: 'bg-emerald-500/15 text-emerald-400' },
  modified: { letter: 'M', label: 'Modified', pill: 'bg-sky-500/15 text-sky-400' },
  deleted: { letter: 'D', label: 'Deleted', pill: 'bg-red-500/15 text-red-400' },
  renamed: { letter: 'R', label: 'Renamed', pill: 'bg-amber-500/15 text-amber-400' },
  untracked: { letter: 'U', label: 'Untracked', pill: 'bg-white/[0.06] text-muted-foreground' },
};

/** The pill presentation for a diff status: emerald for added, sky for modified,
 *  red for deleted, amber for renamed, muted for untracked. */
export function diffStatusMeta(status: DiffStatus): DiffStatusMeta {
  return STATUS_META[status];
}
