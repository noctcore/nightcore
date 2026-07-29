/** The Policy activity card: the rails actually firing.
 *
 *  Every PreToolUse decision was already recorded by the flight recorder, but the
 *  only readers were deterministic gates — so a project's rails were invisible
 *  until the moment they parked a task. This card reads them back newest-first
 *  with why-denied attribution, so an author can see that their `--no-verify` rule
 *  stopped three commits this week (or that a rule they believed was armed has
 *  never fired once). */
import { Badge, Button, EmptyState, LockIcon, Skeleton, Spinner } from '@/components/ui';

import type { ActivityRow } from './PolicyActivity.hooks';
import { usePolicyActivity } from './PolicyActivity.hooks';
import type { PolicyActivityProps } from './PolicyActivity.types';

/** One decision row: what was stopped, why, on which target, and when. */
function ActivityLine({ row }: { row: ActivityRow }) {
  const { entry } = row;
  return (
    <li className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={entry.decision === 'ask' ? 'warning' : 'destructive'}>
          {entry.decision === 'ask' ? 'Asked' : 'Blocked'}
        </Badge>
        <span className="text-2xs-plus font-semibold text-foreground">{row.label}</span>
        <Badge tone={row.fromPolicy ? 'primary' : 'neutral'}>
          {row.fromPolicy ? 'your policy' : 'built-in rail'}
        </Badge>
        {row.age !== null && (
          <span className="ml-auto shrink-0 text-2xs text-muted-foreground/80">{row.age}</span>
        )}
      </div>
      <p className="break-all font-mono text-2xs leading-snug text-muted-foreground">
        {entry.tool}
        {entry.inputDigest.length > 0 && (
          <>
            {' · '}
            <span className="text-foreground">{entry.inputDigest}</span>
          </>
        )}
      </p>
      <p className="text-3xs text-muted-foreground/80">
        {entry.taskTitle ?? entry.taskId} · rule{' '}
        <span className="font-mono">{entry.ruleId}</span>
      </p>
    </li>
  );
}

/** The activity feed card. */
export function PolicyActivity(props: PolicyActivityProps) {
  const view = usePolicyActivity(props);

  return (
    <section
      aria-label="Policy activity"
      className="flex flex-col gap-3 rounded-nc border border-border bg-white/[0.015] p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-xs-plus3 font-semibold text-foreground">Policy activity</h3>
          <p className="text-2xs-plus text-muted-foreground">
            Every tool call this project’s rails stopped or escalated, newest first — read back
            from the per-task flight recorder, with the rule that decided.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!view.pending && !view.empty && (
            <span className="text-2xs text-muted-foreground">
              {view.fromPolicyCount} from your policy
            </span>
          )}
          <Button variant="ghost" onClick={props.onRefresh} disabled={props.loading}>
            {props.loading && <Spinner size={12} />}
            Refresh
          </Button>
        </div>
      </div>

      {view.pending ? (
        <div role="status" aria-busy className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : view.empty ? (
        <EmptyState
          className="min-h-[140px]"
          icon={<LockIcon size={18} />}
          title="No blocked calls recorded"
          description="Nothing has hit these rails yet. That means either the agents stayed inside them, or no session has run since the policy was armed."
        />
      ) : (
        <ul className="flex flex-col">
          {view.rows.map((row) => (
            <ActivityLine key={row.entry.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}
