import { Button, CheckIcon, MoveIcon, Spinner } from '@/components/ui';

import { useTaskActions } from '../actions';
import { deriveProposedSubtasksView } from './ProposedSubtasksPanel.hooks';
import type { ProposedSubtasksPanelProps } from './ProposedSubtasksPanel.types';

/** The Proposed sub-tasks panel for a `decompose` task's detail drawer. Renders the
 *  sub-tasks the run proposed; each open proposal offers a Convert-to-task action,
 *  and a header Convert-all converts the rest at once. Converted rows show a muted
 *  "task" badge (the child appears on the board via the `nc:task` echo). When the
 *  run finished with NO proposals it renders an explicit notice (plus the failure
 *  reason when one is set) instead of nothing, so a decompose that produced no
 *  convertible work — or failed its structured-output contract — says so. The
 *  convert handlers come from `TaskActionsContext`; convert state is owned by the
 *  board controller. */
export function ProposedSubtasksPanel({
  taskId,
  subtasks,
  pending = false,
  error = null,
}: ProposedSubtasksPanelProps) {
  const { onConvertSubtask: onConvert, onConvertAllSubtasks: onConvertAll } =
    useTaskActions();
  const { openCount, convertedCount, total, allConverted } =
    deriveProposedSubtasksView(subtasks);

  // Finished with nothing to convert: explain it rather than rendering blank where
  // the convert list would be. The `error` (when the run FAILED — e.g. the SDK
  // exhausted its structured-output retries) is shown as the reason.
  if (total === 0) {
    const reason = error !== null && error.trim().length > 0 ? error : null;
    return (
      <div className="rounded-nc border border-border bg-white/[0.02] px-3 py-2.5">
        <p className="text-xs-plus2 text-foreground/90">
          Decompose produced no convertible sub-tasks.
        </p>
        {reason !== null && (
          <p className="mt-1 text-2xs leading-snug text-muted-foreground">
            {reason}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
          {convertedCount > 0
            ? `${convertedCount}/${total} converted`
            : `${total} proposed`}
        </span>
        {onConvertAll !== undefined && !allConverted && (
          <Button
            variant="secondary"
            disabled={pending || openCount === 0}
            aria-busy={pending}
            onClick={() => onConvertAll(taskId)}
          >
            {pending ? <Spinner /> : <MoveIcon size={14} />}
            Convert all
          </Button>
        )}
      </div>

      <ul className="space-y-2">
        {subtasks.map((sub) => {
          const converted = sub.status === 'converted';
          return (
            <li
              key={sub.id}
              className="rounded-nc border border-border bg-white/[0.02] px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-xs-plus2 font-semibold text-foreground">
                    {sub.title}
                  </p>
                  {sub.prompt.trim().length > 0 && (
                    <p className="mt-0.5 line-clamp-2 text-2xs leading-snug text-muted-foreground">
                      {sub.prompt}
                    </p>
                  )}
                </div>
                {converted ? (
                  <span className="flex shrink-0 items-center gap-1 rounded-md bg-success/[0.12] px-1.5 py-0.5 font-mono text-3xs font-semibold text-success">
                    <CheckIcon size={11} />
                    task
                  </span>
                ) : (
                  onConvert !== undefined && (
                    <Button
                      variant="secondary"
                      disabled={pending}
                      aria-busy={pending}
                      // Each row's button shares the visible label "Convert"; the
                      // aria-label disambiguates them for screen readers by title.
                      aria-label={`Convert to task: ${sub.title}`}
                      onClick={() => onConvert(taskId, sub.id)}
                    >
                      {pending ? <Spinner /> : <MoveIcon size={14} />}
                      Convert
                    </Button>
                  )
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
