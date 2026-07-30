import { Badge, Kbd, LayersIcon } from '@/components/ui';

import { useStagesStep } from './StagesStep.hooks';
import type { StageDiagramRow } from './StagesStep.types';

/** One link in the lifecycle chain: a numbered marker on a connector rail, the
 *  stage name and its nav destination, the explainer, and the artifact it leaves
 *  behind. */
function StageLink({ stage, number, last }: StageDiagramRow) {
  return (
    <li className="flex gap-4">
      <div className="flex shrink-0 flex-col items-center">
        <div className="flex size-7 items-center justify-center rounded-full bg-primary/15 font-mono text-xs-plus2 font-bold text-primary">
          {number}
        </div>
        {!last && <div className="mt-1 w-px flex-1 bg-primary/25" />}
      </div>
      <div className={last ? 'min-w-0' : 'min-w-0 pb-4'}>
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h2 className="text-[15px] font-semibold tracking-tight">{stage.label}</h2>
          <span className="text-2xs-plus text-muted-foreground">{stage.verb}</span>
          <Badge tone="neutral">{stage.destination}</Badge>
        </div>
        <p className="mt-1 max-w-[560px] text-2xs-plus leading-relaxed text-muted-foreground">
          {stage.summary}
        </p>
        <p className="mt-1 font-mono text-4xs-plus uppercase tracking-[0.08em] text-muted-foreground/70">
          leaves behind: {stage.produces}
        </p>
      </div>
    </li>
  );
}

/** The onboarding step that transmits the five-stage model. Work moves Intake →
 *  Understand → Harden → Enforce → Verify, and each stage's row names the sidebar
 *  destination it lives at, so the diagram doubles as a map of the nav the user is
 *  about to see. Copy is data (`@/lib/stages`), shared with the sidebar explainers. */
export function StagesStep() {
  const rows = useStagesStep();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex size-11 items-center justify-center rounded-[12px] bg-primary/[0.13] text-primary">
        <LayersIcon size={22} />
      </div>
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">How Nightcore works</h1>
        <p className="mt-1.5 max-w-[560px] text-xs-plus leading-6 text-muted-foreground">
          Work moves through five stages. The sidebar is grouped by them, so wherever
          you are, you can see which stage you are in — and every stage leaves an
          artifact behind for the next one.
        </p>
      </div>
      <ol className="mt-0.5 flex flex-col">
        {rows.map((row) => (
          <StageLink key={row.stage.id} {...row} />
        ))}
      </ol>
      <p className="max-w-[560px] text-2xs-plus leading-relaxed text-muted-foreground">
        You do not have to run them in order — the Kanban board, worktrees, and
        terminal sit outside the lifecycle and are always available. Press <Kbd>?</Kbd>{' '}
        anywhere in the app for the shortcut sheet, which lists every stage and its key.
      </p>
    </div>
  );
}
