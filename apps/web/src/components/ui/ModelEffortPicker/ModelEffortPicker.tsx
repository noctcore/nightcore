import { EFFORT_OPTIONS, MODEL_OPTIONS } from '@/lib/models';
import { activeModelId } from './ModelEffortPicker.hooks';
import type { ModelEffortPickerProps } from './ModelEffortPicker.types';

const CHIP =
  'rounded-[10px] border px-3 py-2 text-left text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

function chipClass(selected: boolean): string {
  return `${CHIP} ${
    selected
      ? 'border-primary/60 bg-primary/[0.1] text-foreground'
      : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
  }`;
}

/** A per-task model + reasoning-effort picker (M4.7 §E/§F). Each row is an
 *  Inherit-plus-options segmented radio over the static known-Claude model set
 *  and the SDK effort levels. Pure presentational; selection state is owned by
 *  the form/detail panel. */
export function ModelEffortPicker({
  model,
  effort,
  onChangeModel,
  onChangeEffort,
  disabled = false,
}: ModelEffortPickerProps) {
  const activeModel = activeModelId(model);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          Model
        </span>
        <div role="radiogroup" aria-label="Model" className="grid grid-cols-2 gap-2">
          <button
            type="button"
            role="radio"
            aria-checked={activeModel === null}
            disabled={disabled}
            onClick={() => onChangeModel(null)}
            className={chipClass(activeModel === null)}
          >
            Inherit
          </button>
          {MODEL_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={activeModel === option.id}
              disabled={disabled}
              onClick={() => onChangeModel(option.id)}
              className={chipClass(activeModel === option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          Reasoning effort
        </span>
        <div role="radiogroup" aria-label="Reasoning effort" className="grid grid-cols-5 gap-2">
          <button
            type="button"
            role="radio"
            aria-checked={effort === null}
            disabled={disabled}
            onClick={() => onChangeEffort(null)}
            className={chipClass(effort === null)}
          >
            Inherit
          </button>
          {EFFORT_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={effort === option.id}
              disabled={disabled}
              onClick={() => onChangeEffort(option.id)}
              className={chipClass(effort === option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
