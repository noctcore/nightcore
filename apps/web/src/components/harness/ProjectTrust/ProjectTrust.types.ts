/** Prop types for the Project trust dashboard card. */
import type { ProjectTrustSummary } from '@/lib/bridge';

/** Props for {@link import('./ProjectTrust').ProjectTrust}.
 *
 *  `summary === null` means "still loading"; a loaded summary with zeroes means
 *  "this repo has no governance history yet" — a distinction the card must keep,
 *  because "nothing measured" and "not read yet" say opposite things about a
 *  project's posture. */
export interface ProjectTrustProps {
  summary: ProjectTrustSummary | null;
  /** True while a read is in flight (the initial load included). */
  loading: boolean;
  /** True while the native save dialog / badge write is in flight. */
  exporting: boolean;
  /** Recompute the summary now. */
  onRefresh: () => void;
  /** Export the shields badge JSON to a user-chosen file. */
  onExportBadge: () => void;
}
