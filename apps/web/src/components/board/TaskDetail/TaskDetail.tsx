import {
  BranchIcon,
  Button,
  CheckIcon,
  CloseIcon,
  CommitIcon,
  IconButton,
  Markdown,
  RefineIcon,
} from '@/components/ui';
import { formatCost, STATUS_LABEL, STATUS_TEXT } from '../status';
import { TaskStatusDot } from '../TaskStatusDot';
import { InteractionDock } from '../InteractionDock';
import { ReviewPanel } from '../ReviewPanel';
import { GauntletResults } from '../GauntletResults';
import { ActivityLog } from '../ActivityLog';
import { GroupLabel, HistoryCard, SessionCard } from '../SessionCard';
import { canMerge, deriveTaskDetailView } from './TaskDetail.hooks';
import type { TaskDetailProps } from './TaskDetail.types';

/** The logs / detail drawer — title, status, parked permission prompts, the
 *  reviewer verdict + verification controls (M4), the readiness gauntlet +
 *  verified-gated merge, the description, the unified activity timeline, the
 *  collapsible Session config card, and the per-status run / approval controls.
 *  A thin layout coordinator: every section is its own sibling component, and the
 *  ~25 action callbacks travel as one grouped `actions` object. */
export function TaskDetail({
  task,
  stream,
  anyRunning,
  prompts = [],
  questions = [],
  gauntlet = null,
  gauntletRunning = false,
  onClose,
  actions,
  isActionPending,
}: TaskDetailProps) {
  const {
    isRunning,
    cost,
    sessions,
    reviewParked,
    planParked,
    kindEditable,
    isDoneColumn,
  } = deriveTaskDetailView(task, stream);
  const mergeable = canMerge(task, gauntlet);
  // Whether the Result band has anything to show (verdict and/or the Done-column
  // readiness gauntlet) — its label is suppressed otherwise so it never sits empty.
  const structureLockFailed =
    task.structureLockResult !== null && !task.structureLockResult.passed;
  const hasResult =
    task.review !== null ||
    structureLockFailed ||
    (isDoneColumn && actions.onRunGauntlet !== undefined);
  // Interactive permission/question prompts moved to the pinned InteractionDock
  // (so they're never lost above a long activity log); the attention band now
  // only holds the plan-approval gate.
  const hasAttention = planParked && task.plan !== null;
  const hasHistory =
    task.sdkSessionId !== null &&
    actions.onResumeSession !== undefined &&
    actions.onRenameSession !== undefined &&
    actions.onTagSession !== undefined;
  const mainMode = task.runMode === 'main';
  // True while the named action is mid-flight for this task — disables the button
  // so it can't double-fire before the `nc:task` echo lands.
  const pending = (action: string): boolean => isActionPending?.(action, task.id) ?? false;

  return (
    <aside className="nc-drawer-enter flex h-full w-[28rem] shrink-0 flex-col border-l border-border bg-popover">
      <header className="flex items-start justify-between gap-3 border-b border-border bg-card px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <TaskStatusDot status={task.status} glow />
            <span
              className={`font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${
                task.status === 'done' && !task.verified
                  ? 'text-muted-foreground'
                  : STATUS_TEXT[task.status]
              }`}
            >
              {task.status === 'done' && task.verified ? 'Verified' : STATUS_LABEL[task.status]}
            </span>
            {cost !== null && (
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                · {formatCost(cost)}
              </span>
            )}
          </div>
          <h2 className="mt-2 truncate text-base font-semibold text-foreground">
            {task.title || 'Untitled task'}
          </h2>
        </div>
        <IconButton label="Close detail panel" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-auto px-4 py-4">
        {/* Needs attention — the plan-approval gate. Permission/question prompts
            live in the pinned InteractionDock below, not here. */}
        {hasAttention && (
          <div className="space-y-3">
            {planParked && task.plan !== null && (
              <section>
                <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  Proposed plan
                </h3>
                <Markdown className="rounded-md border border-info/40 bg-info/[0.08] px-3 py-2">
                  {task.plan}
                </Markdown>
              </section>
            )}
          </div>
        )}

        {/* Result — the verification verdict and pre-merge readiness gauntlet. */}
        {hasResult && (
          <div className="space-y-3">
            <GroupLabel>Result</GroupLabel>
            <ReviewPanel
              task={task}
              onAccept={actions.onAcceptReview}
              onReject={actions.onRejectReview}
              onRerun={actions.onRerunVerification}
            />
            {isDoneColumn && actions.onRunGauntlet !== undefined && (
              <GauntletResults
                result={gauntlet}
                running={gauntletRunning}
                onRun={() => actions.onRunGauntlet!(task.id)}
                structureLock={task.structureLockResult}
              />
            )}
          </div>
        )}

        {/* Overview — what was asked for and how the session is configured. */}
        <div className="space-y-3">
          <GroupLabel>Overview</GroupLabel>
          {task.description.trim().length > 0 && (
            <section>
              <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                Description
              </h3>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                {task.description}
              </p>
            </section>
          )}
          <SessionCard task={task} kindEditable={kindEditable} actions={actions} />
        </div>

        {/* Activity — every session's logs, grouped (build, verification, …). */}
        <div className="space-y-3">
          <GroupLabel>Activity</GroupLabel>
          <ActivityLog sessions={sessions} isRunning={isRunning} />
        </div>

        {/* History — past SDK sessions for this task (resume / rename / tag). */}
        {hasHistory && (
          <div className="space-y-3">
            <GroupLabel>History</GroupLabel>
            <HistoryCard
              task={task}
              // Resume requires no run in flight (the run path leases a slot), so
              // gate it the same way the footer Run button is gated.
              canResume={!anyRunning && !isRunning && task.status !== 'verifying'}
              actions={actions}
            />
          </div>
        )}
      </div>

      {/* Pinned interaction dock — auto-surfaces parked permission/question prompts
          so they're actionable without scrolling the activity log above. Gated on
          the permission handler (always co-provided with the question handler in
          the app); a missing question handler degrades to a no-op. */}
      {actions.onRespondPermission !== undefined && (
        <InteractionDock
          taskId={task.id}
          permissionPrompts={prompts}
          questionPrompts={questions}
          onRespondPermission={actions.onRespondPermission}
          onAnswerQuestion={actions.onAnswerQuestion ?? (() => {})}
        />
      )}

      <footer className="flex items-center gap-2 border-t border-border bg-card px-4 py-3">
        {planParked ? (
          <>
            <Button onClick={() => actions.onApprove?.(task.id)} disabled={pending('approve')}>
              <CheckIcon size={14} />
              {pending('approve') ? 'Approving…' : 'Approve'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => actions.onRefine?.(task.id)}
              disabled={pending('refine')}
            >
              <RefineIcon size={14} />
              {pending('refine') ? 'Refining…' : 'Refine'}
            </Button>
            <span className="flex-1" />
            <Button
              variant="danger"
              onClick={() => actions.onReject?.(task.id)}
              disabled={pending('reject')}
            >
              {pending('reject') ? 'Rejecting…' : 'Reject'}
            </Button>
          </>
        ) : reviewParked ? (
          <>
            <span className="flex-1 text-xs text-muted-foreground">
              Resolve the reviewer verdict above.
            </span>
            <Button variant="ghost" onClick={() => actions.onDelete(task.id)}>
              Delete
            </Button>
          </>
        ) : isDoneColumn ? (
          <>
            {task.merged ? (
              <Button disabled title="Branch merged into the base">
                <BranchIcon size={14} />
                Merged
              </Button>
            ) : task.committed && mainMode ? (
              <Button
                disabled
                title="Main-mode tasks edit the project directly — nothing to merge"
              >
                <CheckIcon size={14} />
                Committed
              </Button>
            ) : task.committed ? (
              <Button
                onClick={() => actions.onMerge?.(task.id)}
                disabled={!mergeable || pending('merge')}
                title={
                  mergeable
                    ? undefined
                    : 'Merge needs a verified task and a passing gauntlet — run the checks first'
                }
              >
                <BranchIcon size={14} />
                {pending('merge') ? 'Merging…' : 'Merge'}
              </Button>
            ) : (
              <Button onClick={() => actions.onCommit?.(task.id)} disabled={pending('commit')}>
                <CommitIcon size={14} />
                {pending('commit') ? 'Committing…' : 'Commit'}
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={() => actions.onDelete(task.id)}>
              Delete
            </Button>
          </>
        ) : (
          <>
            {isRunning || task.status === 'verifying' ? (
              <Button variant="danger" onClick={() => actions.onCancel(task.id)}>
                Cancel run
              </Button>
            ) : (
              <Button
                onClick={() => actions.onRun(task.id)}
                disabled={anyRunning || pending('run')}
                title={anyRunning ? 'Another task is already running' : undefined}
              >
                {pending('run') ? 'Starting…' : 'Run'}
              </Button>
            )}
            <span className="flex-1" />
            {!isRunning && task.status !== 'verifying' && (
              <Button variant="ghost" onClick={() => actions.onDelete(task.id)}>
                Delete
              </Button>
            )}
          </>
        )}
      </footer>
    </aside>
  );
}
