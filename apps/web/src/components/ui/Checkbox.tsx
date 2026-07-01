/** A labeled checkbox row: a native (screen-reader + keyboard) checkbox visually
 *  presented as a rounded box with a check glyph, plus its label. Presentational —
 *  the parent owns the checked state. Used by the Board Background panel's toggles. */
import { CheckIcon } from './icons';

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

export function Checkbox({ checked, onChange, label, disabled = false }: CheckboxProps) {
  return (
    <label
      className={`flex select-none items-center gap-2.5 text-[13px] text-foreground ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      }`}
    >
      {/* Real checkbox for semantics + keyboard; visually replaced by the box below. */}
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring ${
          checked
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-white/[0.02]'
        }`}
      >
        {checked && <CheckIcon size={12} />}
      </span>
      <span>{label}</span>
    </label>
  );
}
