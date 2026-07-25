/** The Scorecard CONFIGURE screen: the run-configuration form, composed from the
 *  shared ScanConfigForm — model/effort plus the dimension chip grid and the big
 *  Grade CTA. A controlled, purely-presentational view of the lifted `config`
 *  state. The live readout + Cancel live on the RUNNING screen (RunProgress). */
import { ModelSelectField, PerfIcon, ScanConfigForm, useShowCostLine } from '@/components/ui';
import { PROVIDER_LABEL } from '@/lib/bridge';
import { modelLabel } from '@/lib/models';

import { ALL_DIMENSIONS, DIMENSION_META } from '../scorecard.constants';
import type { RunControlsProps } from './RunControls.types';

const CHIPS = ALL_DIMENSIONS.map((d) => ({
  key: d,
  label: DIMENSION_META[d].label,
  icon: DIMENSION_META[d].icon,
}));

export function RunControls({ config, isStarting, onGrade }: RunControlsProps) {
  const { model } = config;
  const dimCount = config.orderedSelected.length;
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
      heading={`Dimensions (${dimCount}/${ALL_DIMENSIONS.length})`}
      chips={CHIPS}
      selected={config.selected}
      onToggle={config.toggle}
      onSelectAll={config.selectAll}
      onSelectNone={config.selectNone}
      canRun={config.canGrade}
      isStarting={isStarting}
      onRun={onGrade}
      ctaIcon={<PerfIcon size={16} />}
      ctaLabel="Grade readiness"
      ctaClassName="w-full justify-center py-2.5 text-xs-plus3"
      hint={
        <>
          Grades the whole repo across {dimCount}{' '}
          {dimCount === 1 ? 'dimension' : 'dimensions'} · ~{config.providerId === 'codex' ? 'Codex' : PROVIDER_LABEL} {modelLabel(model)}
          {showCost && ' · cost depends on repo size'}.
        </>
      }
    />
  );
}
