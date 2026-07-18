/** Props for {@link Checkbox}. */
export interface CheckboxProps {
  /** Whether the box is checked. */
  checked: boolean;
  /** Called with the next checked value on toggle. */
  onChange: (checked: boolean) => void;
  /** The visible label to the right of the box (also the accessible name). */
  label: string;
  /** Extra sr-only text appended to the accessible name (never shown) — lets a
   *  row of same-labelled checkboxes announce uniquely (e.g. the finding title)
   *  while the visible label stays constant. */
  srSuffix?: string;
  /** Disable interaction (dimmed). */
  disabled?: boolean;
}
