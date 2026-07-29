import { Button, CheckIcon, CloseIcon, LockIcon, PlusIcon, TextField } from '@/components/ui';

import { TaskStatusDot } from '../TaskStatusDot';
import { candidateLabel, useDependencyEditor } from './DependencyEditor.hooks';
import type { DependencyEditorProps } from './DependencyEditor.types';

const ROW_CLASS =
  'flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-2.5 py-1.5';

/** The dependency editor (#402): author which OTHER tasks this one waits on.
 *
 *  The core has stored and enforced `Task.dependencies` since M1 —
 *  `orchestration::deps` refuses to launch a task until every id in the list is `Done`,
 *  and `run_order` orders the board from it — but there was no UI to write it, so chains
 *  had to be hand-minted in the task JSON. This is that authoring surface.
 *
 *  A candidate that would close a cycle is shown DISABLED with the reason rather than
 *  hidden: `deps_satisfied` fails closed, so a cycle isn't an error, it's a silent
 *  never-runs — the one failure the user must be warned about before saving. A dangling
 *  dependency (its task was deleted) is surfaced the same way, since the coordinator
 *  treats it as permanently unsatisfied. */
export function DependencyEditor(props: DependencyEditorProps) {
  const v = useDependencyEditor(props);
  return (
    <section className="flex flex-col gap-2">
      {v.rows.length === 0 ? (
        <p className="text-2xs-plus leading-snug text-muted-foreground">
          Runs as soon as a slot is free. Add a dependency to hold it until another task
          finishes.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {v.rows.map((row) => (
            <li key={row.id} className={ROW_CLASS}>
              {row.satisfied ? (
                <CheckIcon size={13} className="shrink-0 text-success" />
              ) : (
                <LockIcon size={13} className="shrink-0 text-warning" />
              )}
              <span
                className={`min-w-0 flex-1 truncate text-xs-plus ${
                  row.title === null ? 'text-destructive' : 'text-foreground'
                }`}
                title={row.title ?? `Deleted task ${row.id}`}
              >
                {row.title ?? 'Deleted task — blocks this run forever'}
              </span>
              {v.canEdit && (
                <button
                  type="button"
                  aria-label={`Remove dependency ${row.title ?? row.id}`}
                  onClick={() => v.remove(row.id)}
                  className="flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <CloseIcon size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {v.canEdit && (
        <>
          <Button
            variant="secondary"
            aria-expanded={v.picking}
            onClick={v.togglePicking}
            className="self-start"
          >
            <PlusIcon size={13} />
            {v.picking ? 'Done' : 'Add dependency'}
          </Button>

          {v.picking && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-black/20 p-2.5">
              <TextField
                value={v.query}
                onChange={(e) => v.setQuery(e.target.value)}
                aria-label="Filter tasks to depend on"
                placeholder="Filter tasks…"
              />
              {v.candidates.length === 0 ? (
                <p className="px-1 py-2 text-2xs-plus text-muted-foreground">
                  No other task matches.
                </p>
              ) : (
                <ul className="flex max-h-56 flex-col gap-1 overflow-auto">
                  {v.candidates.map(({ task: candidate, blockedReason }) => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        disabled={blockedReason !== null}
                        title={blockedReason ?? undefined}
                        onClick={() => v.add(candidate.id)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                          blockedReason !== null
                            ? 'cursor-not-allowed opacity-40'
                            : 'hover:bg-white/[0.06]'
                        }`}
                      >
                        <TaskStatusDot status={candidate.status} />
                        <span className="min-w-0 flex-1 truncate text-xs-plus text-foreground">
                          {candidateLabel(candidate)}
                        </span>
                        {blockedReason !== null && (
                          <span className="shrink-0 font-mono text-4xs-plus text-warning">
                            cycle
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
