/** Props for {@link Toggle}. */
export interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  /** Accessible label (the switch has no visible text). */
  label: string;
}
