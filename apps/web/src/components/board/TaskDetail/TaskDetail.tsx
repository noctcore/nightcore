import type { ReactNode } from 'react';
import {
  BoltIcon,
  BranchIcon,
  Button,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CommitIcon,
  HistoryIcon,
  IconButton,
  LayersIcon,
  LogsIcon,
  Markdown,
  ModelEffortPicker,
  RefineIcon,
  TerminalIcon,
} from '@/components/ui';
import type { Task } from '@/lib/bridge';
import { parseNumericCommit } from '@/lib/numeric-field';
import { summarizeInput } from '@/lib/summarize';
import {
  formatCost,
  KIND_LABEL,
  modelDisplayName,
  PERMISSION_MODE_LABEL,
  RUN_MODE_LABEL,
  STATUS_LABEL,
  STATUS_TEXT,
} from '../status';
import type { SessionGroup, SessionPhase, TimelineEntry } from '../session-stream';
import { TaskStatusDot } from '../TaskStatusDot';
import { InteractionDock } from '../InteractionDock';
import { KindPicker } from '../KindPicker';
import { WorkModePicker } from '../WorkModePicker';
import { PermissionModePicker } from '../PermissionModePicker';
import { ReviewPanel } from '../ReviewPanel';
import { GauntletResults } from '../GauntletResults';
import { SessionHistory } from '../SessionHistory';
import {
  canMerge,
  deriveTaskDetailView,
  summarizeSession,
  useCollapse,
  useHistoryCard,
  useSessionCard,
} from './TaskDetail.hooks';
import type { TaskDetailProps } from './TaskDetail.types';

/** The expand animation for the collapsible Session card body. */
const SESSION_CARD_REVEAL = 'nc-rise .16s cubic-bezier(.22,1,.36,1)';

/** An editable numeric ceiling (SDK guardrails). Empty ⇒ inherit the resolved
 *  default (the placeholder shows it). Commits a parsed value on blur/Enter via
 *  `onCommit`; a blank/invalid/unchanged value is a no-op — the override can be
 *  SET but, like model/effort, not cleared back to inherit from here. */
function LimitField({
  label,
  value,
  placeholder,
  min,
  step,
  prefix,
  onCommit,
}: {
  label: string;
  value: number | null;
  placeholder: string;
  min: number;
  step: number;
  prefix?: string;
  onCommit: (next: number) => void;
}) {
  const commit = (raw: string) => {
    const parsed = parseNumericCommit(raw, value, min);
    if (parsed !== null) onCommit(parsed);
  };
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-black/20 px-2 py-1 focus-within:border-primary">
        {prefix !== undefined && (
          <span className="font-mono text-[11px] text-muted-foreground">{prefix}</span>
        )}
        <input
          type="number"
          inputMode="numeric"
          min={min}
          step={step}
          defaultValue={value ?? ''}
          key={value ?? 'empty'}
          placeholder={placeholder}
          aria-label={label}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="w-full bg-transparent font-mono text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground/60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </span>
    </label>
  );
}

/** A labeled control row inside the expanded Session card. The two-column
 *  `[5.5rem_1fr]` grid tightens the five formerly-stacked config sections into a
 *  compact form while keeping each `<h3>` label token unchanged. */
function SessionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-x-3 gap-y-1">
      <h3 className="pt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </h3>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A read-only config value pill — the post-run, un-editable rendering of a
 *  session setting. Extracted (#11) so the six identical mono pills that the
 *  readonly Session body used to inline share one styled element. */
function ConfigPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

/** The editable Session body — the live pickers shown while a task is still
 *  pre-run (backlog/ready). Every control is the existing picker/`LimitField`,
 *  unchanged; this just isolates the editable arm of the former ternary (#11). */
function EditableSessionBody({
  task,
  onChangeKind,
  onChangeRunMode,
  onChangePermissionMode,
  onChangeModel,
  onChangeEffort,
  onChangeMaxTurns,
  onChangeMaxBudget,
}: {
  task: Task;
  onChangeKind: NonNullable<TaskDetailProps['onChangeKind']>;
  onChangeRunMode: NonNullable<TaskDetailProps['onChangeRunMode']>;
  onChangePermissionMode: NonNullable<TaskDetailProps['onChangePermissionMode']>;
  onChangeModel: NonNullable<TaskDetailProps['onChangeModel']>;
  onChangeEffort: NonNullable<TaskDetailProps['onChangeEffort']>;
  onChangeMaxTurns: NonNullable<TaskDetailProps['onChangeMaxTurns']>;
  onChangeMaxBudget: NonNullable<TaskDetailProps['onChangeMaxBudget']>;
}) {
  return (
    <>
      <SessionRow label="Kind">
        <KindPicker compact value={task.kind} onChange={(kind) => onChangeKind(task.id, kind)} />
      </SessionRow>
      <SessionRow label="Run mode">
        <WorkModePicker
          value={task.runMode}
          onChange={(runMode) => onChangeRunMode(task.id, runMode)}
        />
      </SessionRow>
      <SessionRow label="Permission">
        <PermissionModePicker
          value={task.permissionMode}
          onChange={(mode) => onChangePermissionMode(task.id, mode)}
        />
      </SessionRow>
      <SessionRow label="Model & effort">
        <ModelEffortPicker
          model={task.model}
          effort={task.effort}
          onChangeModel={(model) => onChangeModel(task.id, model)}
          onChangeEffort={(effort) => onChangeEffort(task.id, effort)}
        />
      </SessionRow>
      <SessionRow label="Limits">
        <div className="flex gap-2.5">
          <LimitField
            label="Max turns"
            value={task.maxTurns}
            placeholder="Inherit"
            min={1}
            step={1}
            onCommit={(n) => onChangeMaxTurns(task.id, n)}
          />
          <LimitField
            label="Max budget (USD)"
            value={task.maxBudgetUsd}
            placeholder="Inherit"
            min={0}
            step={0.5}
            prefix="$"
            onCommit={(n) => onChangeMaxBudget(task.id, n)}
          />
        </div>
      </SessionRow>
    </>
  );
}

/** The read-only Session body — the post-run rendering of the same five settings
 *  as static `ConfigPill`s (#11). */
function ReadonlySessionBody({ task }: { task: Task }) {
  return (
    <>
      <SessionRow label="Kind">
        <ConfigPill>{KIND_LABEL[task.kind]}</ConfigPill>
      </SessionRow>
      <SessionRow label="Run mode">
        <ConfigPill>{RUN_MODE_LABEL[task.runMode]}</ConfigPill>
      </SessionRow>
      <SessionRow label="Permission">
        <ConfigPill>
          {task.permissionMode !== null ? PERMISSION_MODE_LABEL[task.permissionMode] : 'Inherit'}
        </ConfigPill>
      </SessionRow>
      <SessionRow label="Model & effort">
        <div className="flex flex-wrap gap-1.5">
          <ConfigPill>
            {task.model !== null ? modelDisplayName(task.model) : 'Model: inherit'}
          </ConfigPill>
          <ConfigPill>Effort: {task.effort ?? 'inherit'}</ConfigPill>
        </div>
      </SessionRow>
      <SessionRow label="Limits">
        <div className="flex flex-wrap gap-1.5">
          <ConfigPill>Turns: {task.maxTurns ?? 'inherit'}</ConfigPill>
          <ConfigPill>
            Budget: {task.maxBudgetUsd !== null ? `$${task.maxBudgetUsd}` : 'inherit'}
          </ConfigPill>
        </div>
      </SessionRow>
    </>
  );
}

/** The collapsible Session card (decision B): collapsed by default to a middot
 *  summary line, expanding to reveal the EXISTING pickers (editable) or read-only
 *  pills (post-run). Collapsed by default; opens on mount when the task is still
 *  editable so a fresh backlog/ready task surfaces its config without a click.
 *  Reuses every picker + `LimitField` verbatim — no control is re-implemented. */
function SessionCard({
  task,
  kindEditable,
  onChangeKind,
  onChangeRunMode,
  onChangePermissionMode,
  onChangeModel,
  onChangeEffort,
  onChangeMaxTurns,
  onChangeMaxBudget,
}: {
  task: Task;
  kindEditable: boolean;
  onChangeKind?: TaskDetailProps['onChangeKind'];
  onChangeRunMode?: TaskDetailProps['onChangeRunMode'];
  onChangePermissionMode?: TaskDetailProps['onChangePermissionMode'];
  onChangeModel?: TaskDetailProps['onChangeModel'];
  onChangeEffort?: TaskDetailProps['onChangeEffort'];
  onChangeMaxTurns?: TaskDetailProps['onChangeMaxTurns'];
  onChangeMaxBudget?: TaskDetailProps['onChangeMaxBudget'];
}) {
  const { open, toggle } = useSessionCard(kindEditable);

  // A task is editable here only while still pre-run (`kindEditable`) AND the
  // shell wired every edit handler (it always passes them together). The split
  // bodies (#11) replace the former per-row editable/readonly ternary.
  const editable =
    kindEditable &&
    onChangeKind !== undefined &&
    onChangeRunMode !== undefined &&
    onChangePermissionMode !== undefined &&
    onChangeModel !== undefined &&
    onChangeEffort !== undefined &&
    onChangeMaxTurns !== undefined &&
    onChangeMaxBudget !== undefined;

  return (
    <section className="rounded-[10px] border border-border bg-white/[0.02]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="session-card-body"
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <BoltIcon size={13} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {open ? 'Session' : summarizeSession(task)}
        </span>
        <ChevronDownIcon
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <div
        id="session-card-body"
        hidden={!open}
        style={open ? { animation: SESSION_CARD_REVEAL } : undefined}
      >
        {open && (
          <div className="grid gap-3 border-t border-border px-3 pb-3 pt-3">
            {editable ? (
              <EditableSessionBody
                task={task}
                onChangeKind={onChangeKind}
                onChangeRunMode={onChangeRunMode}
                onChangePermissionMode={onChangePermissionMode}
                onChangeModel={onChangeModel}
                onChangeEffort={onChangeEffort}
                onChangeMaxTurns={onChangeMaxTurns}
                onChangeMaxBudget={onChangeMaxBudget}
              />
            ) : (
              <ReadonlySessionBody task={task} />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** The collapsible History card: the per-task SDK session history (past runs,
 *  view transcript, resume, rename, tag). Mirrors `SessionCard`'s collapsible
 *  chrome but collapsed by default — history is a secondary, on-demand surface.
 *  Only rendered for a task that has run (`task.sdkSessionId != null`) and only
 *  when the shell wired the resume/rename/tag handlers. `SessionHistory` owns its
 *  own fetch lifecycle, so the body mounts (and fetches) only once expanded. */
function HistoryCard({
  task,
  canResume,
  onResumeSession,
  onRenameSession,
  onTagSession,
}: {
  task: Task;
  canResume: boolean;
  onResumeSession: NonNullable<TaskDetailProps['onResumeSession']>;
  onRenameSession: NonNullable<TaskDetailProps['onRenameSession']>;
  onTagSession: NonNullable<TaskDetailProps['onTagSession']>;
}) {
  const { open, toggle } = useHistoryCard();
  return (
    <section className="rounded-[10px] border border-border bg-white/[0.02]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="history-card-body"
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <HistoryIcon size={13} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          History
        </span>
        <ChevronDownIcon
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div id="history-card-body" hidden={!open}>
        {open && (
          <div className="border-t border-border px-3 pb-3 pt-3">
            <SessionHistory
              taskId={task.id}
              currentSdkSessionId={task.sdkSessionId}
              canResume={canResume}
              onResume={onResumeSession}
              onRename={onRenameSession}
              onTag={onTagSession}
            />
          </div>
        )}
      </div>
    </section>
  );
}

/** A short, divider-style band label that groups the drawer's many sections into
 *  scannable bands (Result / Overview / Activity / History). Uppercase mono to
 *  match the existing section-heading vocabulary, with a hairline rule. */
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
        {children}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

/** Display label for a session's lifecycle phase. A generic `session` falls back
 *  to `Run N` (handled at the call site, which knows the ordinal). */
const PHASE_LABEL: Record<SessionPhase, string> = {
  build: 'Build',
  verify: 'Verification',
  plan: 'Plan',
  session: 'Run',
};

/** The grouped activity log: one collapsible block per session in the task's
 *  transcript. Keeping every session means the in-progress build run stays
 *  visible alongside the later verification run (the old single-stream model
 *  wiped the build when the verification session started). */
function ActivityLog({
  sessions,
  isRunning,
}: {
  sessions: SessionGroup[];
  isRunning: boolean;
}) {
  return (
    <section aria-label="Activity">
      <h3 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        <LogsIcon size={11} />
        {isRunning ? 'Live activity' : 'Activity'}
      </h3>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {isRunning
            ? 'Waiting for first token…'
            : 'No activity yet — run this task to stream its transcript.'}
        </p>
      ) : sessions.length === 1 ? (
        // A single session needs no collapsible chrome — render it inline.
        <TimelineBody
          entries={sessions[0]!.stream.entries}
          error={sessions[0]!.stream.error}
          isRunning={isRunning}
        />
      ) : (
        <div className="space-y-2">
          {sessions.map((session, i) => (
            <SessionLog
              key={`${session.index}-${session.sdkSessionId ?? 'live'}`}
              session={session}
              // The most recent session is the live / most-relevant one — open it
              // by default and collapse the earlier runs.
              defaultOpen={i === sessions.length - 1}
              isRunning={isRunning && i === sessions.length - 1}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** One collapsible session block within the activity log: a header summarizing
 *  the session (phase, model, tool count, cost) over the session's timeline. */
function SessionLog({
  session,
  defaultOpen,
  isRunning,
}: {
  session: SessionGroup;
  defaultOpen: boolean;
  isRunning: boolean;
}) {
  const { open, toggle } = useCollapse(defaultOpen);
  const { entries, error, costUsd, toolCount } = session.stream;
  const label = session.phase === 'session' ? `Run ${session.index}` : PHASE_LABEL[session.phase];
  const meta = [
    session.model !== null ? modelDisplayName(session.model) : null,
    toolCount > 0 ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : null,
    costUsd !== null ? formatCost(costUsd) : null,
  ].filter((x): x is string => x !== null);

  return (
    <section className="rounded-[10px] border border-border bg-white/[0.02]">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <TerminalIcon size={13} className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/90">
          {label}
        </span>
        {isRunning && (
          <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-primary">
            Live
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground">
          {meta.join(' · ')}
        </span>
        <ChevronDownIcon
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div hidden={!open}>
        {open && (
          <div className="border-t border-border px-3 pb-3 pt-3">
            <TimelineBody entries={entries} error={error} isRunning={isRunning} />
          </div>
        )}
      </div>
    </section>
  );
}

/** The header-less activity list for a single session: assistant text turns
 *  interleaved with boxed tool-call / subagent lines, in arrival order. The live
 *  cursor renders only on a trailing text entry; a terminal error replaces the
 *  list entirely. Shared by the inline single-session view and each collapsible
 *  `SessionLog`. */
function TimelineBody({
  entries,
  error,
  isRunning,
}: {
  entries: TimelineEntry[];
  error: string | null;
  isRunning: boolean;
}) {
  return (
    <>
      {error !== null ? (
        <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/[0.12] px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </pre>
      ) : entries.length > 0 ? (
        <ol
          className="space-y-2.5"
          aria-live={isRunning ? 'polite' : undefined}
          aria-atomic={isRunning ? 'false' : undefined}
        >
          {entries.map((entry, i) => {
            if (entry.kind === 'text') {
              const isLast = i === entries.length - 1;
              return (
                // Stable per-entry key (C6) — `entry.id` keeps a growing turn's
                // identity so React reconciles it in place instead of remounting.
                <li key={`t${entry.id}`} className="text-foreground">
                  {entry.closed ? (
                    // Closed turn: parse markdown once (the heavy marked+DOMPurify
                    // pass) — it no longer changes, so no O(n²) reparse.
                    <Markdown>{entry.markdown}</Markdown>
                  ) : (
                    // Open (still-streaming) turn: render as plain text while it
                    // grows, so each delta is a cheap text update, not a reparse.
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                      {entry.markdown}
                    </p>
                  )}
                  {isRunning && isLast && (
                    <span
                      aria-hidden="true"
                      className="ml-0.5 inline-block w-[2px] animate-[nc-pulse_1s_ease-in-out_infinite] align-text-bottom text-primary"
                    >
                      ▌
                    </span>
                  )}
                </li>
              );
            }
            if (entry.kind === 'task') {
              const label = entry.subagentType ?? 'Subagent';
              const detail = entry.summary ?? entry.description;
              return (
                <li
                  key={`s${entry.id}`}
                  className="flex items-start gap-1.5 rounded-md border border-info/30 bg-info/[0.06] px-2 py-1 font-mono text-xs text-info"
                >
                  <LayersIcon size={12} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    <span className="font-semibold">{label}</span>
                    {entry.status !== undefined && (
                      <span className="text-muted-foreground"> · {entry.status}</span>
                    )}
                    {detail !== undefined && detail.length > 0 && (
                      <span className="text-muted-foreground"> · {detail}</span>
                    )}
                  </span>
                </li>
              );
            }
            return (
              <li
                key={`x${entry.id}`}
                className="flex items-start gap-1.5 rounded-md border border-border bg-white/[0.02] px-2 py-1 font-mono text-xs text-primary/80"
              >
                <TerminalIcon size={12} className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">
                  <span className="font-semibold">{entry.toolName}</span>
                  {entry.input !== undefined && (
                    <span className="text-muted-foreground"> · {summarizeInput(entry.input)}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">
          {isRunning ? 'Waiting for first token…' : 'No activity recorded for this session.'}
        </p>
      )}
    </>
  );
}

/** The logs / detail drawer — title, status, parked permission prompts, the
 *  reviewer verdict + verification controls (M4), the readiness gauntlet +
 *  verified-gated merge, the description, the unified activity timeline, the
 *  collapsible Session config card, and the per-status run / approval controls. */
export function TaskDetail({
  task,
  stream,
  anyRunning,
  prompts = [],
  questions = [],
  gauntlet = null,
  gauntletRunning = false,
  onClose,
  onRun,
  onCancel,
  onDelete,
  onRespondPermission,
  onAnswerQuestion,
  onApprove,
  onReject,
  onRefine,
  onChangeKind,
  onChangeRunMode,
  onChangePermissionMode,
  onChangeModel,
  onChangeEffort,
  onChangeMaxTurns,
  onChangeMaxBudget,
  onAcceptReview,
  onRejectReview,
  onRerunVerification,
  onRunGauntlet,
  onMerge,
  onCommit,
  onResumeSession,
  onRenameSession,
  onTagSession,
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
  const hasResult = task.review !== null || (isDoneColumn && onRunGauntlet !== undefined);
  // Interactive permission/question prompts moved to the pinned InteractionDock
  // (so they're never lost above a long activity log); the attention band now
  // only holds the plan-approval gate.
  const hasAttention = planParked && task.plan !== null;
  const hasHistory =
    task.sdkSessionId !== null &&
    onResumeSession !== undefined &&
    onRenameSession !== undefined &&
    onTagSession !== undefined;
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
              onAccept={onAcceptReview}
              onReject={onRejectReview}
              onRerun={onRerunVerification}
            />
            {isDoneColumn && onRunGauntlet !== undefined && (
              <GauntletResults
                result={gauntlet}
                running={gauntletRunning}
                onRun={() => onRunGauntlet(task.id)}
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
          <SessionCard
            task={task}
            kindEditable={kindEditable}
            onChangeKind={onChangeKind}
            onChangeRunMode={onChangeRunMode}
            onChangePermissionMode={onChangePermissionMode}
            onChangeModel={onChangeModel}
            onChangeEffort={onChangeEffort}
            onChangeMaxTurns={onChangeMaxTurns}
            onChangeMaxBudget={onChangeMaxBudget}
          />
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
              onResumeSession={onResumeSession!}
              onRenameSession={onRenameSession!}
              onTagSession={onTagSession!}
            />
          </div>
        )}
      </div>

      {/* Pinned interaction dock — auto-surfaces parked permission/question prompts
          so they're actionable without scrolling the activity log above. Gated on
          the permission handler (always co-provided with the question handler in
          the app); a missing question handler degrades to a no-op. */}
      {onRespondPermission !== undefined && (
        <InteractionDock
          taskId={task.id}
          permissionPrompts={prompts}
          questionPrompts={questions}
          onRespondPermission={onRespondPermission}
          onAnswerQuestion={onAnswerQuestion ?? (() => {})}
        />
      )}

      <footer className="flex items-center gap-2 border-t border-border bg-card px-4 py-3">
        {planParked ? (
          <>
            <Button onClick={() => onApprove?.(task.id)} disabled={pending('approve')}>
              <CheckIcon size={14} />
              {pending('approve') ? 'Approving…' : 'Approve'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => onRefine?.(task.id)}
              disabled={pending('refine')}
            >
              <RefineIcon size={14} />
              {pending('refine') ? 'Refining…' : 'Refine'}
            </Button>
            <span className="flex-1" />
            <Button
              variant="danger"
              onClick={() => onReject?.(task.id)}
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
            <Button variant="ghost" onClick={() => onDelete(task.id)}>
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
                onClick={() => onMerge?.(task.id)}
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
              <Button onClick={() => onCommit?.(task.id)} disabled={pending('commit')}>
                <CommitIcon size={14} />
                {pending('commit') ? 'Committing…' : 'Commit'}
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={() => onDelete(task.id)}>
              Delete
            </Button>
          </>
        ) : (
          <>
            {isRunning || task.status === 'verifying' ? (
              <Button variant="danger" onClick={() => onCancel(task.id)}>
                Cancel run
              </Button>
            ) : (
              <Button
                onClick={() => onRun(task.id)}
                disabled={anyRunning || pending('run')}
                title={anyRunning ? 'Another task is already running' : undefined}
              >
                {pending('run') ? 'Starting…' : 'Run'}
              </Button>
            )}
            <span className="flex-1" />
            {!isRunning && task.status !== 'verifying' && (
              <Button variant="ghost" onClick={() => onDelete(task.id)}>
                Delete
              </Button>
            )}
          </>
        )}
      </footer>
    </aside>
  );
}
