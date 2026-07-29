/** Presentational sub-parts of the run-order sheet (the sanctioned `.parts.tsx` overflow
 *  pattern). All state + joins live in `RunOrderPanel.hooks.ts` / `.utils.ts`. */
import { LockIcon } from '@/components/ui';
import { pluralize } from '@/lib/formatters';

import type { RunOrderRow } from './RunOrderPanel.types';

/** One row of the ordered list: its position, title, the blockers it waits on, and how
 *  many concurrency passes away it is. Clickable when the board wired `onSelectTask` (it
 *  opens the task's drawer); otherwise a plain row, so presentational stories stay inert. */
export function RunOrderRowItem({
  row,
  onSelectTask,
}: {
  row: RunOrderRow;
  onSelectTask?: (id: string) => void;
}) {
  const shell = `flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left ${
    row.startsNow ? 'border-primary/45 bg-primary/[0.06]' : 'border-border bg-white/[0.02]'
  }`;
  const body = (
    <>
      <span
        className={`w-6 shrink-0 font-mono text-2xs tabular-nums ${
          row.startsNow ? 'font-semibold text-primary' : 'text-muted-foreground'
        }`}
      >
        {row.position}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs-plus text-foreground">{row.title}</span>
        {row.blockedBy.length > 0 && (
          <span className="mt-0.5 block truncate font-mono text-4xs-plus text-warning">
            waits on {row.blockedBy.join(', ')}
          </span>
        )}
      </span>
      {!row.startsNow && (
        <span className="shrink-0 font-mono text-4xs-plus text-muted-foreground">
          +{pluralize(row.wave, 'pass', 'passes')}
        </span>
      )}
    </>
  );
  if (onSelectTask === undefined) return <div className={shell}>{body}</div>;
  return (
    <button
      type="button"
      // An explicit accessible name: the concatenated row text would otherwise read
      // "1Extract the settings storewaits on …", and a row whose BLOCKER is another row's
      // title would be ambiguous to name-based navigation (and to tests).
      aria-label={`Open ${row.title} — run order position ${row.position}`}
      onClick={() => onSelectTask(row.id)}
      className={`${shell} transition-colors hover:border-white/25`}
    >
      {body}
    </button>
  );
}

/** The "starts now" cut line drawn after the last wave-0 row — everything above it launches
 *  on the very next auto-loop pass. */
export function StartsNowDivider() {
  return (
    <div className="flex items-center gap-2 py-1">
      <span aria-hidden className="h-px flex-1 bg-primary/40" />
      <span className="font-mono text-4xs-plus uppercase tracking-[0.1em] text-primary">
        starts now · above
      </span>
      <span aria-hidden className="h-px flex-1 bg-primary/40" />
    </div>
  );
}

/** The group for launchable tasks with NO reachable position: a missing, failed, or
 *  circular dependency means the fail-closed loop will never pick them up. Given its own
 *  group rather than a fake position — inventing one would be the exact dishonesty the
 *  run-order work removes. */
export function NeverEligibleGroup({ rows }: { rows: { id: string; title: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-mono text-3xs uppercase tracking-[0.1em] text-warning">
        Never eligible ({rows.length})
      </h3>
      <p className="text-2xs-plus leading-snug text-muted-foreground">
        A dependency is missing, failed, or circular — the loop fails closed and will never
        pick these up. Fix the dependency to give them a position.
      </p>
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/[0.08] px-2.5 py-1.5"
          >
            <LockIcon size={13} className="shrink-0 text-warning" />
            <span className="min-w-0 flex-1 truncate text-xs-plus text-foreground">
              {row.title}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
