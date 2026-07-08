/** Props for {@link NumberField}. */
export interface NumberFieldProps {
  value: number | null;
  placeholder: string;
  onCommit: (next: number) => void;
  step?: string;
  min?: number;
  ariaLabel: string;
  prefix?: string;
}
