/** Props for the {@link import('./StaleChip').StaleChip} shared status chip. */
export interface StaleChipProps {
  /** Tooltip explaining why the issue is stale — differs per surface. */
  title: string;
  /** Extra classes on the chip wrapper (e.g. `ml-auto` for the results header). */
  className?: string;
}
