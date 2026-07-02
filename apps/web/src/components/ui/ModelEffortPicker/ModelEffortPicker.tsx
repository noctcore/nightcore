/** Per-task model and reasoning-effort selection control. */
import type { ComponentType } from 'react';

import {
  effortOptionsForModel,
  isAdaptiveModel,
  isEffortSupported,
  MODEL_OPTIONS,
  modelOptionFor,
  type ModelTier,
} from '@/lib/models';

import { BoltIcon, BrainIcon, PerfIcon, SparkIcon } from '../icons';
import { activeModelId } from './ModelEffortPicker.hooks';
import type { ModelEffortPickerProps } from './ModelEffortPicker.types';

const LABEL =
  'font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground';

/** The tier glyph: Premium = spark, Balanced = gauge, Speed = bolt. */
const TIER_ICON: Record<ModelTier, ComponentType<{ size?: number; className?: string }>> = {
  Premium: SparkIcon,
  Balanced: PerfIcon,
  Speed: BoltIcon,
};

/** Class string for a model chip in its selected/unselected state. */
function modelChipClass(selected: boolean): string {
  return `flex items-center gap-2 rounded-[10px] border px-3 py-2 text-left text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    selected
      ? 'border-primary/60 bg-primary/[0.1] text-foreground'
      : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
  }`;
}

/** Class string for an effort chip in its selected/unselected state. */
function effortChipClass(selected: boolean): string {
  return `rounded-[9px] border px-2.5 py-1.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    selected
      ? 'border-primary/60 bg-primary/[0.1] text-foreground'
      : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
  }`;
}

/** Class string for the per-model tier badge. */
function tierBadgeClass(tier: ModelTier): string {
  return `rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${
    tier === 'Premium' ? 'bg-primary/[0.16] text-primary' : 'bg-white/[0.06] text-muted-foreground'
  }`;
}

/** A per-task model + reasoning-effort picker. The model row is a
 *  vertical radio list of the known Claude models with a tier badge + one-line
 *  capability description; the reasoning row is model-aware — it surfaces only the
 *  effort levels the selected model supports (the premium tier unlocks the higher
 *  levels), and hints when the model reasons adaptively. Pure presentational;
 *  selection state is owned by the form/detail panel. When the model changes to one
 *  that can't honor the pinned effort, the effort resets to Inherit so no invisible
 *  unsupported level lingers. */
export function ModelEffortPicker({
  model,
  effort,
  onChangeModel,
  onChangeEffort,
  disabled = false,
}: ModelEffortPickerProps) {
  const activeModel = activeModelId(model);
  const activeLabel = modelOptionFor(model)?.label ?? null;
  const effortOptions = effortOptionsForModel(model);
  const adaptive = isAdaptiveModel(model);

  /** Pick a model, reconciling a pinned effort the new model can't honor. */
  function pickModel(next: string | null): void {
    onChangeModel(next);
    if (!isEffortSupported(next, effort)) onChangeEffort(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>Model</span>
        <div role="radiogroup" aria-label="Model" className="flex flex-col gap-1.5">
          <button
            type="button"
            role="radio"
            aria-checked={activeModel === null}
            aria-label="Inherit"
            disabled={disabled}
            onClick={() => pickModel(null)}
            className={modelChipClass(activeModel === null)}
          >
            <span className="font-semibold">Inherit</span>
            <span className="ml-auto truncate text-[11px] text-muted-foreground" aria-hidden>
              Use the default model
            </span>
          </button>
          {MODEL_OPTIONS.map((option) => {
            const selected = activeModel === option.id;
            const Icon = TIER_ICON[option.tier];
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={option.label}
                disabled={disabled}
                onClick={() => pickModel(option.id)}
                className={modelChipClass(selected)}
              >
                <Icon size={14} className="shrink-0 text-muted-foreground" />
                <span className="font-semibold">{option.label}</span>
                <span className={tierBadgeClass(option.tier)} aria-hidden>
                  {option.tier}
                </span>
                <span className="ml-auto truncate text-[11px] text-muted-foreground" aria-hidden>
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <BrainIcon size={12} className="text-muted-foreground" />
          <span className={LABEL}>Reasoning effort</span>
          {adaptive && (
            <span className="text-[10px] font-medium text-primary/80">
              · {activeLabel} decides adaptively
            </span>
          )}
        </div>
        <div role="radiogroup" aria-label="Reasoning effort" className="flex flex-wrap gap-2">
          <button
            type="button"
            role="radio"
            aria-checked={effort === null}
            aria-label="Inherit"
            title={adaptive ? 'Adaptive — the model decides' : 'Use the default effort'}
            disabled={disabled}
            onClick={() => onChangeEffort(null)}
            className={effortChipClass(effort === null)}
          >
            Inherit
          </button>
          {effortOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={effort === option.id}
              aria-label={option.label}
              title={option.description}
              disabled={disabled}
              onClick={() => onChangeEffort(option.id)}
              className={effortChipClass(effort === option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
