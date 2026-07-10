/** The Understand stage shell: a slim Find | Grade toggle above the existing
 *  Insight (find→fix) and Scorecard (grade→harden) view-models. It owns only the
 *  toggle state — each inner view keeps its own contract, engine, `useScanRun`,
 *  and run store, so run history stays per-mode and persistence is untouched.
 *
 *  Lives under `components/app/` (the composition root) because it imports two
 *  feature views across boundaries — legal only here, where
 *  `no-cross-feature-imports` is lifted. */
import { InsightView } from '@/components/insight';
import { ScorecardView } from '@/components/scorecard';
import { Segmented } from '@/components/ui';

import { useUnderstandView } from './UnderstandView.hooks';
import type { UnderstandViewProps } from './UnderstandView.types';

const MODE_OPTIONS: [value: string, label: string][] = [
  ['find', 'Find'],
  ['grade', 'Grade'],
];

export function UnderstandView(props: UnderstandViewProps) {
  const view = useUnderstandView(props);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Slim segmented header: Find mounts Insight, Grade mounts the Scorecard.
          Both mount ONE inner view at a time (the other unmounts); a live run in
          the hidden mode keeps running and reconnects via `useScanRun` on remount. */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <div role="group" aria-label="Understand lens">
          <Segmented options={MODE_OPTIONS} value={view.mode} onChange={view.selectMode} />
        </div>
        <span className="text-[12px] text-muted-foreground">
          {view.mode === 'find'
            ? 'Find issues to fix in the active project.'
            : 'Grade the active project’s production readiness.'}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {view.mode === 'find' ? (
          <InsightView
            projectPath={props.projectPath}
            projectName={props.projectName}
            onGotoBoard={props.onGotoBoard}
            preselect={view.findPreselect}
            onPreselectConsumed={props.onPreselectConsumed}
          />
        ) : (
          <ScorecardView
            projectPath={props.projectPath}
            projectName={props.projectName}
            onGotoBoard={props.onGotoBoard}
            preselect={view.gradePreselect}
            onPreselectConsumed={props.onPreselectConsumed}
          />
        )}
      </div>
    </div>
  );
}
