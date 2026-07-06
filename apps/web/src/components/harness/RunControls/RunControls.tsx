/** The Harness CONFIGURE screen body: the run configuration hero, composed from
 *  the shared ScanConfigForm — model/effort, the convention-lens chip grid, and
 *  the primary Scan CTA with a cost hint. Fully controlled by the shared
 *  run-config (lifted to the HarnessView hook) so it survives phase swaps and
 *  pre-fills on a new run. Harness always scans the whole repo, so there is no
 *  scope picker. The live readout + Cancel live on the RUNNING screen
 *  (RunProgress). */
import { ScanConfigForm, Spinner, VerifiedIcon } from '@/components/ui';
import { MODEL_OPTIONS } from '@/lib/models';

import { ALL_CATEGORIES, CATEGORY_META } from '../harness.constants';
import type { RunControlsProps } from './RunControls.types';

const CHIPS = ALL_CATEGORIES.map((c) => ({
  key: c,
  label: CATEGORY_META[c].label,
  icon: CATEGORY_META[c].icon,
}));

function modelLabel(model: string | null): string {
  if (model === null) return 'the inherited model';
  return MODEL_OPTIONS.find((m) => m.id === model)?.label ?? model;
}

export function RunControls({ config, isStarting, onScan }: RunControlsProps) {
  const lensCount = config.orderedSelected.length;

  return (
    <ScanConfigForm
      scrollable={false}
      model={config.model}
      effort={config.effort}
      onChangeModel={config.setModel}
      onChangeEffort={config.setEffort}
      heading={`Lenses (${lensCount}/${ALL_CATEGORIES.length})`}
      chips={CHIPS}
      selected={config.selected}
      onToggle={config.toggle}
      onSelectAll={config.selectAll}
      onSelectNone={config.selectNone}
      canRun={config.canRun}
      isStarting={isStarting}
      onRun={onScan}
      ctaIcon={<VerifiedIcon size={16} />}
      ctaBusyIcon={<Spinner size={16} />}
      ctaLabel="Scan"
      ctaClassName="w-full justify-center py-2.5 text-[13.5px]"
      hint={
        <>
          Scans the whole repo across {lensCount} {lensCount === 1 ? 'lens' : 'lenses'}{' '}
          · ~Claude {modelLabel(config.model)} · cost depends on repo size.
        </>
      }
    />
  );
}
