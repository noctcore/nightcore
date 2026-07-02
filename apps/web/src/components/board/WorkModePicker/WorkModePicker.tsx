import { rovingKeydown } from '@/lib/roving-keydown';

import { RUN_MODE_OPTIONS } from '../status';
import { runModeIcon } from './WorkModePicker.hooks';
import type { WorkModePickerProps } from './WorkModePicker.types';

/** A segmented Main-vs-Worktree run-mode picker for task create/edit — a
 *  card-per-mode radio toggle with a one-line explainer beneath the selection.
 *  Pure presentational: selection state is owned by the form/detail panel. */
export function WorkModePicker({ value, onChange, disabled = false }: WorkModePickerProps) {
  const selectedHint = RUN_MODE_OPTIONS.find((option) => option.mode === value)?.hint;

  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label="Run mode" className="grid grid-cols-2 gap-2">
        {RUN_MODE_OPTIONS.map((option) => {
          const Icon = runModeIcon(option.mode);
          const selected = option.mode === value;
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
              className={`flex items-center gap-1.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? 'border-primary/60 bg-primary/[0.1]'
                  : 'border-border bg-white/[0.02] hover:border-white/20'
              }`}
            >
              <span className={selected ? 'text-primary' : 'text-muted-foreground'}>
                <Icon size={14} />
              </span>
              <span className="text-[13px] font-semibold text-foreground">{option.label}</span>
            </button>
          );
        })}
      </div>
      {selectedHint !== undefined && (
        <p className="text-[11px] leading-snug text-muted-foreground">{selectedHint}</p>
      )}
    </div>
  );
}
