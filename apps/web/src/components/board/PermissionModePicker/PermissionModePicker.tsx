import { PERMISSION_MODE_OPTIONS } from '../status';
import { permissionModeHint } from './PermissionModePicker.hooks';
import type { PermissionModePickerProps } from './PermissionModePicker.types';

const CHIP =
  'rounded-[10px] border px-3 py-2.5 text-left text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/** A per-task permission-mode picker (M4.7 §F): Inherit (default) plus the four
 *  UI modes (bypass / auto-accept / ask / plan). A sibling of KindPicker —
 *  segmented radios with a one-line explainer beneath. Pure presentational;
 *  selection state is owned by the form/detail panel. */
export function PermissionModePicker({ value, onChange, disabled = false }: PermissionModePickerProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label="Permission mode" className="grid grid-cols-3 gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          disabled={disabled}
          onClick={() => onChange(null)}
          className={`${CHIP} ${
            value === null
              ? 'border-primary/60 bg-primary/[0.1] text-foreground'
              : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
          }`}
        >
          Inherit
        </button>
        {PERMISSION_MODE_OPTIONS.map((option) => {
          const selected = option.mode === value;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(option.mode)}
              className={`${CHIP} ${
                selected
                  ? 'border-primary/60 bg-primary/[0.1] text-foreground'
                  : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{permissionModeHint(value)}</p>
    </div>
  );
}
