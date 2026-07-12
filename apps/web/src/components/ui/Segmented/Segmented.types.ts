/** Props for {@link Segmented}. */
export interface SegmentedProps {
  options: [value: string, label: string][];
  value: string;
  onChange: (value: string) => void;
  /** Render the control visible-but-inert (e.g. a not-yet-built affordance). */
  disabled?: boolean;
  /** Accessible name for the radiogroup (WCAG 4.1.2). Ignored when `ariaLabelledBy`
   *  is given; falls back to a label built from the option text when neither prop
   *  is provided. */
  ariaLabel?: string;
  /** Id of an element that already visually labels this control (e.g. a settings
   *  row's own label) — takes precedence over `ariaLabel` when both are given. */
  ariaLabelledBy?: string;
}
