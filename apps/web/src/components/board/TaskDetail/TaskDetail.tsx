import { memo } from 'react';

import {
  BranchIcon,
  Button,
  CheckIcon,
  CloseIcon,
  CommitIcon,
  GithubIcon,
  IconButton,
  Markdown,
  RefineIcon,
  Spinner,
} from '@/components/ui';
import { sourceRefLabel } from '@/lib/source-ref';

import { ActivityLog } from '../ActivityLog';
import { GauntletResults } from '../GauntletResults';
import { InteractionDock } from '../InteractionDock';
import { ProposedSubtasksPanel } from '../ProposedSubtasksPanel';
import { PrReviewComments, usePrReviewComments } from '../PrReviewComments';
import { PrStatusCard, usePrStatus } from '../PrStatusCard';
import { ReviewPanel } from '../ReviewPanel';
import { GroupLabel, HistoryCard, SessionCard } from '../SessionCard';
import { formatCost, STATUS_LABEL, STATUS_TEXT } from '../status';
import { TaskAttachments } from '../TaskAttachments';
import { TaskStatusDot } from '../TaskStatusDot';
import {
  canCreatePr,
  canMerge,
  deriveTaskDetailView,
  prChipLabel,
  TaskStreamContext,
  usePrSupport,
  useTaskStreamSessions,
} from './TaskDetail.hooks';
import type { TaskDetailChromeProps, TaskDetailProps } from './TaskDetail.types';


/** The logs / detail drawer. A thin coordinator over two halves: the static
 *  `TaskDetailChrome` (title, verdict, gauntlet, description, session config, and
 *  the per-status controls) and the live activity timeline.
 *
 *  The `stream` prop changes on every rAF flush during a run, so this function
 *  re-renders up to 60fps — but it forwards only the DERIVED view scalars to the
 *  memoized chrome (never the stream), so the chrome bails on a flush. The live
 *  session groups reach the deep `<ActivityLog>` through {@link TaskStreamContext}
 *  instead, so a flush reconciles only the log — not the whole drawer subtree. */
export function TaskDetail({
  task,
  stream,
  anyRunning,
  prompts = [],
  questions = [],
  gauntlet = null,
  gauntletRunning = false,
  prSupport,
  prStatus,
  prReviewComments,
  onClose,
  actions,
  isActionPending,
  onOpenSourceRef,
}: TaskDetailProps) {
  const { isRunning, cost, sessions, reviewParked, planParked, kindEditable, isDoneColumn } =
    deriveTaskDetailView(task, stream);
  // Lazy PR capability probe (gh + origin remote), cached per task id; the
  // `prSupport` prop (stories/tests) overrides and skips the fetch entirely.
  const resolvedPrSupport = usePrSupport(task, prSupport);
  // The PR status hook is LIFTED here (not owned by the card) so the footer
  // shares the fetched state — Merge disables when the PR is already merged on
  // GitHub. Enabled only once a PR exists; `prStatus` (stories/tests) overrides
  // and skips the fetch. The returned view is memoized, so the chrome memo
  // below still bails on stream flushes.
  const prStatusView = usePrStatus(task.id, prStatus, task.prUrl !== undefined);
  // The review-comments hook is LIFTED here too (mirroring `usePrStatus`) so its
  // fetched state is memoized and survives stream flushes. Enabled only once a
  // PR exists; outside Tauri it resolves an empty payload (the quiet empty note).
  const prReviewCommentsView = usePrReviewComments(
    task.id,
    task.prUrl !== undefined,
    prReviewComments,
  );
  return (
    <TaskStreamContext.Provider value={sessions}>
      <TaskDetailChrome
        task={task}
        cost={cost}
        isRunning={isRunning}
        reviewParked={reviewParked}
        planParked={planParked}
        kindEditable={kindEditable}
        isDoneColumn={isDoneColumn}
        anyRunning={anyRunning}
        prompts={prompts}
        questions={questions}
        gauntlet={gauntlet}
        gauntletRunning={gauntletRunning}
        prSupport={resolvedPrSupport}
        prStatusView={prStatusView}
        prReviewCommentsView={prReviewCommentsView}
        onClose={onClose}
        actions={actions}
        isActionPending={isActionPending}
        onOpenSourceRef={onOpenSourceRef}
      />
    </TaskStreamContext.Provider>
  );
}

/** The live activity timeline, split out of the memoized chrome so a per-frame
 *  stream flush re-renders ONLY this subtree. It reads the session groups from
 *  {@link TaskStreamContext} (fed by the drawer's Provider) rather than a prop, so
 *  the chrome around it stays put on a flush while React still re-renders this
 *  context consumer. */
function TaskActivity({ isRunning }: { isRunning: boolean }) {
  const sessions = useTaskStreamSessions();
  return <ActivityLog sessions={sessions} isRunning={isRunning} />;
}

/** The static drawer chrome around the activity timeline — everything that does
 *  NOT depend on the per-frame stream. Memoized so a stream flush (which re-renders
 *  the outer `TaskDetail`) bails here: every prop is referentially stable across
 *  flushes. Every section is its own sibling component, and the ~25 action
 *  callbacks travel as one grouped `actions` object. */
const TaskDetailChrome = memo(function TaskDetailChrome({
  task,
  cost,
  isRunning,
  reviewParked,
  planParked,
  kindEditable,
  isDoneColumn,
  anyRunning,
  prompts,
  questions,
  gauntlet,
  gauntletRunning,
  prSupport,
  prStatusView,
  prReviewCommentsView,
  onClose,
  actions,
  isActionPending,
  onOpenSourceRef,
}: TaskDetailChromeProps) {
  const mergeable = canMerge(task, gauntlet);
  // Freshly-fetched PR state (from the lifted status view): a PR already
  // merged ON GitHub must not arm the local Merge — the worktree branch was
  // integrated remotely, and a local merge would re-apply it against a base
  // that may already contain it. Finalize is the correct exit.
  const remoteMerged = prStatusView.status?.state === 'MERGED';
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
  // Provenance chip: where a converted task came from (scan finding/reading/proposal).
  const provenance = sourceRefLabel(task.sourceRef);
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
          {provenance !== null && task.sourceRef !== null && (
            onOpenSourceRef !== undefined ? (
              <button
                type="button"
                onClick={() => onOpenSourceRef(task.sourceRef!)}
                title="Open the originating scan item"
                className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
              >
                From {provenance} ↗
              </button>
            ) : (
              <span className="mt-1.5 inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                From {provenance}
              </span>
            )
          )}
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
              pending={pending}
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

        {/* Pull request — live GitHub status for the task's PR (phase 2): state /
            review / checks badges plus the human-gated push-updates, remote-merged
            finalize, and base fast-forward actions. Fetches on mount + manual
            refresh only; sits directly below the Result band's gauntlet. */}
        {task.prUrl !== undefined && (
          <div className="space-y-3">
            <GroupLabel>Pull request</GroupLabel>
            {/* Keyed per task (suspenders — the hook's own task-switch reset is
                the belt) so a switch remounts the card: no stale status/error
                snapshot or armed confirm dialog can carry from task A to B. */}
            <PrStatusCard
              key={task.id}
              task={task}
              view={prStatusView}
              onOpenPr={actions.onOpenPr}
              onPushUpdates={actions.onPushPrUpdates}
              onFinalize={actions.onFinalizePr}
              onPullBase={actions.onPullBaseFf}
              isActionPending={isActionPending}
            />
          </div>
        )}

        {/* Review comments — the UNRESOLVED inline threads + top-level review
            summaries for the task's PR (phase 3), read-only, plus the single
            human-gated Address-comments action (dispatches a fix run over the
            worktree). Fetches on mount + manual refresh; sits directly below the
            PR status band. Comment bodies are untrusted external text. */}
        {task.prUrl !== undefined && (
          <div className="space-y-3">
            <GroupLabel>Review comments</GroupLabel>
            {/* Keyed per task (suspenders — the hook's own task-switch reset is
                the belt) so a switch remounts the card: no stale payload or armed
                confirm dialog can carry from task A to B. */}
            <PrReviewComments
              key={task.id}
              task={task}
              view={prReviewCommentsView}
              onAddressComments={actions.onAddressPrComments}
              isActionPending={isActionPending}
            />
          </div>
        )}

        {/* Proposed sub-tasks — a `decompose` run's output, each convertible into a
            board task. Shown once the run has FINISHED (done/failed): a run that
            proposed something lists the proposals; one that produced nothing (or
            failed its structured-output contract) shows an explicit notice with the
            failure reason, so the band never renders blank where the list would be. */}
        {task.kind === 'decompose' &&
          (task.status === 'done' || task.status === 'failed') && (
            <div className="space-y-3">
              <GroupLabel>Proposed sub-tasks</GroupLabel>
              <ProposedSubtasksPanel
                taskId={task.id}
                subtasks={task.proposedSubtasks}
                onConvert={actions.onConvertSubtask}
                onConvertAll={actions.onConvertAllSubtasks}
                pending={pending('convertSubtask') || pending('convertAllSubtasks')}
                error={task.error}
              />
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
              <Markdown className="text-sm leading-relaxed text-foreground/90">
                {task.description}
              </Markdown>
            </section>
          )}
          {(task.attachments.length > 0 || kindEditable) && (
            <TaskAttachments task={task} editable={kindEditable} />
          )}
          <SessionCard task={task} kindEditable={kindEditable} actions={actions} />
        </div>

        {/* Activity — every session's logs, grouped (build, verification, …).
            The live session groups arrive via TaskStreamContext, so this is the
            only band that re-renders on a per-frame stream flush. */}
        <div className="space-y-3">
          <GroupLabel>Activity</GroupLabel>
          <TaskActivity isRunning={isRunning} />
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
            <Button
              onClick={() => actions.onApprove?.(task.id)}
              disabled={pending('approve')}
              aria-busy={pending('approve')}
            >
              {pending('approve') ? <Spinner /> : <CheckIcon size={14} />}
              {pending('approve') ? 'Approving…' : 'Approve'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => actions.onRefine?.(task.id)}
              disabled={pending('refine')}
              aria-busy={pending('refine')}
            >
              {pending('refine') ? <Spinner /> : <RefineIcon size={14} />}
              {pending('refine') ? 'Refining…' : 'Refine'}
            </Button>
            <span className="flex-1" />
            <Button
              variant="danger"
              onClick={() => actions.onReject?.(task.id)}
              disabled={pending('reject')}
              aria-busy={pending('reject')}
            >
              {pending('reject') ? <Spinner /> : null}
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
                disabled={!mergeable || remoteMerged || pending('merge')}
                aria-busy={pending('merge')}
                title={
                  remoteMerged
                    ? 'Merged on GitHub — use Finalize'
                    : mergeable
                      ? undefined
                      : 'Merge needs a verified task and a passing gauntlet — run the checks first'
                }
              >
                {pending('merge') ? <Spinner /> : <BranchIcon size={14} />}
                {pending('merge') ? 'Merging…' : 'Merge'}
              </Button>
            ) : (
              <Button
                onClick={() => actions.onCommit?.(task.id)}
                disabled={pending('commit')}
                aria-busy={pending('commit')}
              >
                {pending('commit') ? <Spinner /> : <CommitIcon size={14} />}
                {pending('commit') ? 'Committing…' : 'Commit'}
              </Button>
            )}
            {/* The PR terminal action beside Merge: a `PR #<n>` chip linking out
                once one exists, else Create PR when the full eligibility contract
                holds (done + verified + committed + worktree + !merged + a green
                `pr_support` probe). Hidden while the probe is unknown or red. */}
            {task.prUrl !== undefined ? (
              <Button
                variant="secondary"
                onClick={() => actions.onOpenPr?.(task.prUrl!)}
                title="Open the pull request in your browser"
              >
                <GithubIcon size={13} />
                {prChipLabel(task)} ↗
              </Button>
            ) : canCreatePr(task, prSupport) && actions.onCreatePr !== undefined ? (
              <Button
                variant="secondary"
                onClick={() => actions.onCreatePr!(task.id)}
                disabled={pending('createPr')}
                aria-busy={pending('createPr')}
              >
                {pending('createPr') ? <Spinner /> : <GithubIcon size={13} />}
                Create PR
              </Button>
            ) : null}
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
                aria-busy={pending('run')}
                title={anyRunning ? 'Another task is already running' : undefined}
              >
                {pending('run') ? <Spinner /> : null}
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
});
