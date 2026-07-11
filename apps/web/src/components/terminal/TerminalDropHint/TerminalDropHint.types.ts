/** Props for the {@link TerminalDropHint} — the drag-over drop-hint overlay
 *  (round-2 PR C). */
export interface TerminalDropHintProps {
  /** Optional extra classes for the overlay wrapper (e.g. a story/test frame). The
   *  overlay is `absolute inset-0` and expects a `relative` positioned parent. */
  readonly className?: string;
}
