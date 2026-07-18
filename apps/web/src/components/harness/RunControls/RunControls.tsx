/** The Harness CONFIGURE screen body: the run configuration hero, composed from
 *  the shared ScanConfigForm — model/effort, the convention-lens chip grid, and
 *  the primary Scan CTA with a cost hint. Fully controlled by the shared
 *  run-config (lifted to the HarnessView hook) so it survives phase swaps and
 *  pre-fills on a new run. Harness always scans the whole repo, so there is no
 *  scope picker. The live readout + Cancel live on the RUNNING screen
 *  (RunProgress). */
import {
  ModelSelectField,
  ScanConfigForm,
  ScanModeToggle,
  Spinner,
  useShowCostLine,
  VerifiedIcon,
} from '@/components/ui';
import { PROVIDER_LABEL } from '@/lib/bridge';
import { modelLabel } from '@/lib/models';

import { ALL_CATEGORIES, CATEGORY_META } from '../harness.constants';
import type { RunControlsProps } from './RunControls.types';

const CHIPS = ALL_CATEGORIES.map((c) => ({
  key: c,
  label: CATEGORY_META[c].label,
  icon: CATEGORY_META[c].icon,
}));

export function RunControls({ config, isStarting, onScan }: RunControlsProps) {
  const lensCount = config.orderedSelected.length;
  const showCost = useShowCostLine();
  const { deep, setDeep } = config;

  return (
    <ScanConfigForm
      scrollable={false}
      picker={
        <ModelSelectField
          value={{
            model: config.model,
            effort: config.effort,
            providerId: config.providerId ?? undefined,
          }}
          onChange={(sel) => {
            config.setModel(sel.model);
            config.setEffort(sel.effort);
            config.setProviderId(sel.providerId ?? null);
          }}
        />
      }
      beforeChips={
        <ScanModeToggle deep={deep} onToggle={setDeep} unitNoun="lens" />
      }
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
      ctaClassName="w-full justify-center py-2.5 text-xs-plus3"
      hint={
        <>
          Scans the whole repo across {lensCount} {lensCount === 1 ? 'lens' : 'lenses'}{' '}
          · ~{config.providerId === 'codex' ? 'Codex' : PROVIDER_LABEL} {modelLabel(config.model)}
          {showCost && ' · cost depends on repo size'}
          {deep &&
            ' · Deep mode: multiple rounds per lens until convergence — can run long'}
          .
        </>
      }
    />
  );
}
