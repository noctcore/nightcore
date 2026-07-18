/** Props for the shared modal-form field primitives. */
import type { InputHTMLAttributes, ReactNode } from 'react';

/** {@link TextField} forwards every native input attribute (value, onChange,
 *  disabled, aria-*, placeholder, id, …); a caller `className` is appended. */
export type TextFieldProps = InputHTMLAttributes<HTMLInputElement>;

/** Props for {@link FieldLabel}. */
export interface FieldLabelProps {
  /** Binds the label to its input (`for`) — required so the label is always
   *  associated with a focusable control (a11y). For a control with no input id
   *  (a custom combobox) use `SectionLabel` (same visual, a `<span>`). */
  htmlFor: string;
  children: ReactNode;
  /** Extra layout classes appended onto the canonical label style (e.g. `mb-1.5 block`). */
  className?: string;
}
