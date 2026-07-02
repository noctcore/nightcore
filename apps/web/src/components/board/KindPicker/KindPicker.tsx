import { rovingKeydown } from '@/lib/roving-keydown';

import { KIND_OPTIONS } from '../status';
import { kindIcon } from './KindPicker.hooks';
import type { KindPickerProps } from './KindPicker.types';

/** A segmented kind picker for task create/edit. Build (default), Research,
 *  TDD, and Decompose are all selectable; `review` is the internal verification
 *  reviewer and is never offered here. The disabled/"soon" path is retained for any
 *  future reserved kind. Pure presentational — selection state is owned by the
 *  form/detail panel. */
export function KindPicker({ value, onChange, compact = false, disabled = false }: KindPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Task kind"
      className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`}
    >
      {KIND_OPTIONS.map((option) => {
        const Icon = kindIcon(option.kind);
        const selected = option.kind === value;
        const inert = disabled || !option.enabled;
        return (
          <button
            key={option.kind}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={inert}
            title={option.enabled ? option.hint : 'Coming soon'}
            onKeyDown={rovingKeydown}
            onClick={() => onChange(option.kind)}
            className={`flex flex-col gap-1 rounded-[10px] border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed ${
              selected
                ? 'border-primary/60 bg-primary/[0.1]'
                : option.enabled
                  ? 'border-border bg-white/[0.02] hover:border-white/20'
                  : 'border-border bg-white/[0.01] opacity-50'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span className={selected ? 'text-primary' : 'text-muted-foreground'}>
                <Icon size={14} />
              </span>
              <span className="text-[13px] font-semibold text-foreground">{option.label}</span>
              {!option.enabled && (
                <span className="ml-auto rounded bg-white/[0.06] px-1 py-px font-mono text-[8px] uppercase tracking-[0.04em] text-muted-foreground">
                  soon
                </span>
              )}
            </span>
            {!compact && (
              <span className="text-[11px] leading-snug text-muted-foreground">{option.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
