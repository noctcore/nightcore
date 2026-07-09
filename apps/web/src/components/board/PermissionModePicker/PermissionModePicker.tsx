import { rovingKeydown } from '@/lib/roving-keydown';

import {
  normalizedPermissionValue,
  permissionModeHint,
  supportedPermissionOptions,
} from './PermissionModePicker.hooks';
import type { PermissionModePickerProps } from './PermissionModePicker.types';

const CHIP =
  'rounded-[10px] border px-3 py-2.5 text-left text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/** A per-task permission-mode picker: Inherit (default) plus the four
 *  UI modes (bypass / auto-accept / ask / plan). A sibling of KindPicker —
 *  segmented radios with a one-line explainer beneath. Pure presentational;
 *  selection state is owned by the form/detail panel. */
export function PermissionModePicker({
  value,
  onChange,
  disabled = false,
  supportedAutonomyLevels,
}: PermissionModePickerProps) {
  const options = supportedPermissionOptions(supportedAutonomyLevels);
  const normalizedValue = normalizedPermissionValue(value, supportedAutonomyLevels);
  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label="Permission mode" className="grid grid-cols-3 gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={normalizedValue === null}
          tabIndex={normalizedValue === null ? 0 : -1}
          disabled={disabled}
          onKeyDown={rovingKeydown}
          onClick={() => onChange(null)}
          className={`${CHIP} ${
            normalizedValue === null
              ? 'border-primary/60 bg-primary/[0.1] text-foreground'
              : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
          }`}
        >
          Inherit
        </button>
        {options.map((option) => {
          const selected = option.mode === normalizedValue;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onKeyDown={rovingKeydown}
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
      <p className="text-[11px] leading-snug text-muted-foreground">
        {permissionModeHint(normalizedValue)}
      </p>
    </div>
  );
}
