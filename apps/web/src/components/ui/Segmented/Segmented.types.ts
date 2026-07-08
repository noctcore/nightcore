/** Props for {@link Segmented}. */
export interface SegmentedProps {
  options: [value: string, label: string][];
  value: string;
  onChange: (value: string) => void;
  /** Render the control visible-but-inert (e.g. a not-yet-built affordance). */
  disabled?: boolean;
}
