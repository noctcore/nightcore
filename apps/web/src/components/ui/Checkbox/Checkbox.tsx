/** A labeled checkbox row: a native (screen-reader + keyboard) checkbox visually
 *  presented as a rounded box with a check glyph, plus its label. Presentational —
 *  the parent owns the checked state. Used by the Board Background panel's toggles. */
import { CheckIcon } from '../icons';
import type { CheckboxProps } from './Checkbox.types';

export function Checkbox({
  checked,
  onChange,
  label,
  srSuffix,
  disabled = false,
}: CheckboxProps) {
  return (
    <label
      className={`flex select-none items-center gap-2.5 text-xs-plus2 text-foreground ${
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
        {/* Kept mounted and scaled in/out so the check springs on toggle (CSS-only). */}
        <CheckIcon
          size={12}
          className={`transition-[transform,opacity] duration-[var(--nc-motion-instant)] ${
            checked ? 'scale-100 opacity-100' : 'scale-0 opacity-0'
          }`}
        />
      </span>
      <span>
        {label}
        {srSuffix !== undefined && <span className="sr-only"> {srSuffix}</span>}
      </span>
    </label>
  );
}
