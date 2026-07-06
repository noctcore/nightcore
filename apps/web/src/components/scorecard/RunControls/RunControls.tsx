/** The Scorecard CONFIGURE screen: the run-configuration form, composed from the
 *  shared ScanConfigForm — model/effort plus the dimension chip grid and the big
 *  Grade CTA. A controlled, purely-presentational view of the lifted `config`
 *  state. The live readout + Cancel live on the RUNNING screen (RunProgress). */
import { PerfIcon, ScanConfigForm } from '@/components/ui';

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

  return (
    <ScanConfigForm
      model={model}
      effort={config.effort}
      onChangeModel={config.setModel}
      onChangeEffort={config.setEffort}
      heading={`Dimensions (${dimCount}/${ALL_DIMENSIONS.length})`}
      chips={CHIPS}
      selected={config.selected}
      onToggle={config.toggle}
      onSelectAll={config.selectAll}
      onSelectNone={config.selectNone}
      canRun={config.canGrade}
      isStarting={isStarting}
      onRun={onGrade}
      ctaIcon={<PerfIcon size={15} />}
      ctaLabel="Grade readiness"
      hint={
        <>
          Grades the whole repo across {dimCount}{' '}
          {dimCount === 1 ? 'dimension' : 'dimensions'} · ~Claude {model ?? 'default'} ·
          cost depends on repo size.
        </>
      }
    />
  );
}
