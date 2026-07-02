import { Button, ModelEffortPicker, PerfIcon, Spinner } from '@/components/ui';

import { ALL_DIMENSIONS, DIMENSION_META } from '../scorecard.constants';
import type { RunControlsProps } from './RunControls.types';

const CHIP =
  'rounded-[10px] border px-3 py-1.5 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

function chipClass(selected: boolean): string {
  return `${CHIP} ${
    selected
      ? 'border-primary/60 bg-primary/[0.1] text-foreground'
      : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
  }`;
}

/** The CONFIGURE screen: the run-configuration form is the hero — model/effort plus
 *  the dimension chip grid and the big Grade CTA. A controlled, purely-presentational
 *  view of the lifted `config` state. The live readout + Cancel live on the RUNNING
 *  screen (RunProgress). */
export function RunControls({ config, isStarting, onGrade }: RunControlsProps) {
  const {
    model,
    setModel,
    effort,
    setEffort,
    selected,
    toggle,
    selectAll,
    selectNone,
    orderedSelected,
    canGrade,
  } = config;

  const dimCount = orderedSelected.length;

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-6 py-10">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          Run config
        </span>

        {/* Model + effort (reuses the shared picker for parity) */}
        <ModelEffortPicker
          model={model}
          effort={effort}
          onChangeModel={setModel}
          onChangeEffort={setEffort}
        />

        {/* Dimensions */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Dimensions ({dimCount}/{ALL_DIMENSIONS.length})
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={selectAll}
                className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                All
              </button>
              <button
                type="button"
                onClick={selectNone}
                className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                None
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_DIMENSIONS.map((d) => {
              const Meta = DIMENSION_META[d];
              const Icon = Meta.icon;
              const on = selected.has(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(d)}
                  className={`inline-flex items-center gap-1.5 ${chipClass(on)}`}
                >
                  <Icon size={13} />
                  {Meta.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Primary CTA + hint */}
        <div className="flex flex-col gap-2">
          <Button
            disabled={!canGrade || isStarting}
            aria-busy={isStarting}
            onClick={onGrade}
            className="w-full sm:w-auto"
          >
            {isStarting ? <Spinner size={15} /> : <PerfIcon size={15} />}
            {isStarting ? 'Starting…' : 'Grade readiness'}
          </Button>
          <p className="text-[12px] text-muted-foreground">
            Grades the whole repo across {dimCount}{' '}
            {dimCount === 1 ? 'dimension' : 'dimensions'} · ~Claude {model ?? 'default'} ·
            cost depends on repo size.
          </p>
        </div>
      </div>
    </div>
  );
}
