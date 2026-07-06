/** The Insight CONFIGURE screen: the run-configuration form, composed from the
 *  shared ScanConfigForm with the repo/diff scope radio as its extra section. */
import { chipClass, InsightIcon, ScanConfigForm } from '@/components/ui';
import type { AnalysisScope } from '@/lib/bridge';

import { ALL_CATEGORIES, CATEGORY_META, SCOPE_META } from '../insight.constants';
import type { RunControlsProps } from './RunControls.types';

const CHIPS = ALL_CATEGORIES.map((c) => ({
  key: c,
  label: CATEGORY_META[c].label,
  icon: CATEGORY_META[c].icon,
}));

/** The CONFIGURE screen: the run-configuration form is the hero — model/effort,
 *  scope, the lens chip grid, and the big Analyze CTA. A controlled,
 *  purely-presentational view of the lifted `config` state. The live readout +
 *  Cancel now live on the RUNNING screen (RunProgress). */
export function RunControls({ config, isStarting, onAnalyze }: RunControlsProps) {
  const { scope, setScope, model } = config;
  const lensCount = config.orderedSelected.length;

  return (
    <ScanConfigForm
      model={model}
      effort={config.effort}
      onChangeModel={config.setModel}
      onChangeEffort={config.setEffort}
      beforeChips={
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
      }
      heading={`Categories (${lensCount}/${ALL_CATEGORIES.length})`}
      chips={CHIPS}
      selected={config.selected}
      onToggle={config.toggle}
      onSelectAll={config.selectAll}
      onSelectNone={config.selectNone}
      canRun={config.canAnalyze}
      isStarting={isStarting}
      onRun={onAnalyze}
      ctaIcon={<InsightIcon size={15} />}
      ctaLabel="Analyze"
      hint={
        <>
          Scans the whole {scope === 'diff' ? 'diff' : 'repo'} across {lensCount}{' '}
          {lensCount === 1 ? 'lens' : 'lenses'} · ~Claude {model ?? 'default'} · cost
          depends on repo size.
        </>
      }
    />
  );
}
