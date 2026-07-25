/** Shared modal-form field primitives: the canonical bordered field class, a text
 *  input built on it, and the mono-uppercase micro field label. Extracted so the
 *  modal forms (Create PR / Create worktree / MCP editor) read identically instead
 *  of each re-declaring a near-duplicate input + label class. */
import { SECTION_LABEL_CLASS } from '../SectionLabel';
import type { FieldLabelProps, TextFieldProps } from './TextField.types';

/** The canonical modal-form input/textarea class: a bordered, dark-filled field
 *  that turns its border primary on focus. Shared by every modal text input and
 *  textarea so they render identically; a `<textarea>` composes it with its own
 *  `font-mono`/`resize-none` as needed. */
export const FIELD_INPUT_CLASS =
  'w-full rounded-nc border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';

/** A single-line text input on the shared field chrome. Forwards every native input
 *  attribute; a caller `className` is appended so a field can layer on e.g.
 *  `font-mono`. */
export function TextField({ className, ...rest }: TextFieldProps) {
  return <input className={`${FIELD_INPUT_CLASS} ${className ?? ''}`} {...rest} />;
}

/** The mono-uppercase micro field label shared by the modal forms — a `<label>`
 *  bound to its input via `htmlFor`, rendered in the canonical section-label style
 *  (the same visual `SectionLabel` uses for label-less controls). */
export function FieldLabel({ htmlFor, children, className }: FieldLabelProps) {
  return (
    <label htmlFor={htmlFor} className={`${SECTION_LABEL_CLASS} ${className ?? ''}`}>
      {children}
    </label>
  );
}
