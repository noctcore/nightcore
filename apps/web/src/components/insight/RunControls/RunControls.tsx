import { Button, InsightIcon, ModelEffortPicker, Spinner } from '@/components/ui';
import type { AnalysisScope } from '@/lib/bridge';
import { ALL_CATEGORIES, CATEGORY_META, SCOPE_META } from '../insight.constants';
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

/** The CONFIGURE screen: the run-configuration form is the hero — model/effort,
 *  scope, the lens chip grid, and the big Analyze CTA. A controlled,
 *  purely-presentational view of the lifted `config` state. The live readout +
 *  Cancel now live on the RUNNING screen (RunProgress). */
export function RunControls({ config, isStarting, onAnalyze }: RunControlsProps) {
  const {
    scope,
    setScope,
    model,
    setModel,
    effort,
    setEffort,
    selected,
    toggle,
    selectAll,
    selectNone,
    orderedSelected,
    canAnalyze,
  } = config;

  const lensCount = orderedSelected.length;

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

        {/* Scope */}
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Scope
          </span>
          <div role="radiogroup" aria-label="Scope" className="flex gap-2">
            {(['repo', 'diff'] as AnalysisScope[]).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                title={SCOPE_META[s].hint}
                onClick={() => setScope(s)}
                className={chipClass(scope === s)}
              >
                {SCOPE_META[s].label}
              </button>
            ))}
          </div>
        </div>

        {/* Categories */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Categories ({lensCount}/{ALL_CATEGORIES.length})
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
            {ALL_CATEGORIES.map((c) => {
              const Meta = CATEGORY_META[c];
              const Icon = Meta.icon;
              const on = selected.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(c)}
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
            disabled={!canAnalyze || isStarting}
            aria-busy={isStarting}
            onClick={onAnalyze}
            className="w-full sm:w-auto"
          >
            {isStarting ? <Spinner size={15} /> : <InsightIcon size={15} />}
            {isStarting ? 'Starting…' : 'Analyze'}
          </Button>
          <p className="text-[12px] text-muted-foreground">
            Scans the whole {scope === 'diff' ? 'diff' : 'repo'} across {lensCount}{' '}
            {lensCount === 1 ? 'lens' : 'lenses'} · ~Claude {model ?? 'default'} · cost
            depends on repo size.
          </p>
        </div>
      </div>
    </div>
  );
}
