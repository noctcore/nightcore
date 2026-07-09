import { memo } from 'react';

import { m, Markdown, slideIn } from '@/components/ui';

import { useTaskActions } from '../actions';
import { ActivityLog } from '../ActivityLog';
import { GauntletResults } from '../GauntletResults';
import { InteractionDock } from '../InteractionDock';
import { ProposedSubtasksPanel } from '../ProposedSubtasksPanel';
import { PrReviewComments, usePrReviewComments } from '../PrReviewComments';
import { PrStatusCard, usePrStatus } from '../PrStatusCard';
import { ReviewPanel } from '../ReviewPanel';
import { GroupLabel, HistoryCard, SessionCard } from '../SessionCard';
import { TaskAttachments } from '../TaskAttachments';
import {
  deriveTaskDetailView,
  TaskStreamContext,
  usePrSupport,
  useTaskStreamSessions,
} from './TaskDetail.hooks';
import type { TaskDetailChromeProps, TaskDetailProps } from './TaskDetail.types';
import { TaskDetailFooter } from './TaskDetailFooter';
import { TaskDetailHeader } from './TaskDetailHeader';


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
 *  callbacks arrive as one grouped, referentially stable object via
 *  `TaskActionsContext` (a context update — not a prop — so it cannot defeat
 *  this memo on a stream flush; the shell's `detailActions` only re-identifies
 *  on a real guard/prompt/toast change). */
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
  isActionPending,
  onOpenSourceRef,
}: TaskDetailChromeProps) {
  const actions = useTaskActions();
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
  // True while the named action is mid-flight for this task — disables the button
  // so it can't double-fire before the `nc:task` echo lands.
  const pending = (action: string): boolean => isActionPending?.(action, task.id) ?? false;

  return (
    <m.aside
      variants={slideIn}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex h-full w-[min(28rem,60vw)] shrink-0 flex-col border-l border-border bg-popover"
    >
      <TaskDetailHeader
        task={task}
        cost={cost}
        onClose={onClose}
        onOpenSourceRef={onOpenSourceRef}
      />

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
            <ReviewPanel task={task} pending={pending} />
            {isDoneColumn && actions.onRunGauntlet !== undefined && (
              <GauntletResults
                result={gauntlet}
                running={gauntletRunning}
                onRunChecks={() => actions.onRunGauntlet!(task.id)}
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
          <SessionCard task={task} kindEditable={kindEditable} />
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
        />
      )}

      <TaskDetailFooter
        task={task}
        gauntlet={gauntlet}
        prSupport={prSupport}
        prStatusView={prStatusView}
        planParked={planParked}
        reviewParked={reviewParked}
        isDoneColumn={isDoneColumn}
        isRunning={isRunning}
        anyRunning={anyRunning}
        pending={pending}
      />
    </m.aside>
  );
});
