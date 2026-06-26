import { Button, ModelEffortPicker, VerifiedIcon } from '@/components/ui';
import { MODEL_OPTIONS } from '@/lib/models';
import { ALL_CATEGORIES, CATEGORY_META } from '../harness.constants';
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

function modelLabel(model: string | null): string {
  if (model === null) return 'the inherited model';
  return MODEL_OPTIONS.find((m) => m.id === model)?.label ?? model;
}

/** The CONFIGURE screen body: the run configuration hero — model/effort, the
 *  convention-lens chip grid, and the primary Scan CTA with a cost hint. Fully
 *  controlled by the shared run-config (lifted to the HarnessView hook) so it
 *  survives phase swaps and pre-fills on a new run. Harness always scans the whole
 *  repo, so there is no scope picker. The live readout + Cancel live on the RUNNING
 *  screen (RunProgress). */
export function RunControls({ config, isStarting, onScan }: RunControlsProps) {
  const lensCount = config.orderedSelected.length;

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-6 py-10">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        Run config
      </span>

      {/* Model + effort (reuses the shared picker for parity) */}
      <ModelEffortPicker
        model={config.model}
        effort={config.effort}
        onChangeModel={config.setModel}
        onChangeEffort={config.setEffort}
      />

      {/* Convention lenses */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Lenses ({lensCount}/{ALL_CATEGORIES.length})
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={config.selectAll}
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              All
            </button>
            <button
              type="button"
              onClick={config.selectNone}
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              None
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {ALL_CATEGORIES.map((c) => {
            const Meta = CATEGORY_META[c];
            const Icon = Meta.icon;
            const on = config.selected.has(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => config.toggle(c)}
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
          disabled={!config.canRun || isStarting}
          onClick={onScan}
          className="w-full justify-center py-2.5 text-[13.5px]"
        >
          <VerifiedIcon size={16} />
          {isStarting ? 'Starting…' : 'Scan'}
        </Button>
        <p className="text-[12px] text-muted-foreground">
          Scans the whole repo across {lensCount} {lensCount === 1 ? 'lens' : 'lenses'}{' '}
          · ~Claude {modelLabel(config.model)} · cost depends on repo size.
        </p>
      </div>
    </div>
  );
}
