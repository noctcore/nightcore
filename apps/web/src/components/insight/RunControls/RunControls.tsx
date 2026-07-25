/** The Insight CONFIGURE screen: the run-configuration form, composed from the
 *  shared ScanConfigForm with the repo/diff scope radio as its extra section. */
import {
  chipClass,
  InsightIcon,
  ModelSelectField,
  ScanConfigForm,
  ScanModeToggle,
  useShowCostLine,
} from '@/components/ui';
import { type AnalysisScope, PROVIDER_LABEL } from '@/lib/bridge';
import { modelLabel } from '@/lib/models';

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
  const { scope, setScope, deep, setDeep, model } = config;
  const lensCount = config.orderedSelected.length;
  const showCost = useShowCostLine();

  return (
    <ScanConfigForm
      picker={
        <ModelSelectField
          value={{ model, effort: config.effort, providerId: config.providerId ?? undefined }}
          onChange={(sel) => {
            config.setModel(sel.model);
            config.setEffort(sel.effort);
            config.setProviderId(sel.providerId ?? null);
          }}
        />
      }
      beforeChips={
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
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
          <ScanModeToggle deep={deep} onToggle={setDeep} unitNoun="category" />
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
      ctaIcon={<InsightIcon size={16} />}
      ctaLabel="Analyze"
      ctaClassName="w-full justify-center py-2.5 text-xs-plus3"
      hint={
        <>
          Scans the whole {scope === 'diff' ? 'diff' : 'repo'} across {lensCount}{' '}
          {lensCount === 1 ? 'lens' : 'lenses'} · ~{config.providerId === 'codex' ? 'Codex' : PROVIDER_LABEL} {modelLabel(model)}
          {showCost && ' · cost depends on repo size'}
          {deep &&
            ' · Deep mode: multiple rounds per category until convergence — can run long'}
          .
        </>
      }
    />
  );
}
