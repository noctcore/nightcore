/** Props for {@link Checkbox}. */
export interface CheckboxProps {
  /** Whether the box is checked. */
  checked: boolean;
  /** Called with the next checked value on toggle. */
  onChange: (checked: boolean) => void;
  /** The visible label to the right of the box (also the accessible name). */
  label: string;
  /** Disable interaction (dimmed). */
  disabled?: boolean;
}
