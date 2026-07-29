/** Prop types for the Policy activity feed. */
import type { PolicyActivityEntry } from '@/lib/bridge';

/** Props for {@link import('./PolicyActivity').PolicyActivity}.
 *
 *  `entries === null` means "still loading"; `[]` means "loaded, nothing to
 *  show" — a distinction the card must keep, because "no denials recorded" and
 *  "not read yet" tell the author opposite things about their rails. */
export interface PolicyActivityProps {
  entries: PolicyActivityEntry[] | null;
  /** True while a refresh read is in flight (the initial load included). */
  loading: boolean;
  /** Re-read the feed now. */
  onRefresh: () => void;
}
