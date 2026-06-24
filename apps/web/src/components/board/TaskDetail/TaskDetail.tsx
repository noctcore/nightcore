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
import type { TimelineEntry } from '../session-stream';
import { TaskStatusDot } from '../TaskStatusDot';
import { PermissionPrompt } from '../PermissionPrompt';
import { KindPicker } from '../KindPicker';
import { WorkModePicker } from '../WorkModePicker';
import { PermissionModePicker } from '../PermissionModePicker';
import { ModelEffortPicker } from '../ModelEffortPicker';
import { ReviewPanel } from '../ReviewPanel';
import { GauntletResults } from '../GauntletResults';
import { SessionHistory } from '../SessionHistory';
import {
  canMerge,
  deriveTaskDetailView,
  summarizeSession,
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

/** The unified activity timeline (decision A): one chronological list that
 *  interleaves assistant text turns (rendered via `<Markdown>`, each its own
 *  `<li>` so distinct turns are visually separated) with boxed tool-call lines,
 *  in arrival order. Replaces the split Tools + Transcript sections. The live
 *  cursor renders only on a trailing text entry; a terminal error replaces the
 *  list entirely. */
function Timeline({
  entries,
  error,
  isRunning,
}: {
  entries: TimelineEntry[];
  error: string | null;
  isRunning: boolean;
}) {
  return (
    <section aria-label="Activity" className="flex-1">
      <h3 className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        <LogsIcon size={11} />
        {isRunning ? 'Live activity' : 'Activity'}
      </h3>

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
          {isRunning
            ? 'Waiting for first token…'
            : 'No activity yet — run this task to stream its transcript.'}
        </p>
      )}
    </section>
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
  gauntlet = null,
  gauntletRunning = false,
  onClose,
  onRun,
  onCancel,
  onDelete,
  onRespondPermission,
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
    error,
    entries,
    reviewParked,
    planParked,
    kindEditable,
    isDoneColumn,
  } = deriveTaskDetailView(task, stream);
  const mergeable = canMerge(task, gauntlet);
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
        {prompts.length > 0 && onRespondPermission !== undefined && (
          <div className="space-y-2">
            {prompts.map((prompt) => (
              <PermissionPrompt
                key={prompt.requestId}
                prompt={prompt}
                onRespond={(requestId, decision) =>
                  onRespondPermission(task.id, requestId, decision)
                }
              />
            ))}
          </div>
        )}

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

        <Timeline entries={entries} error={error} isRunning={isRunning} />

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

        {task.sdkSessionId !== null &&
          onResumeSession !== undefined &&
          onRenameSession !== undefined &&
          onTagSession !== undefined && (
            <HistoryCard
              task={task}
              // Resume requires no run in flight (the run path leases a slot), so
              // gate it the same way the footer Run button is gated.
              canResume={!anyRunning && !isRunning && task.status !== 'verifying'}
              onResumeSession={onResumeSession}
              onRenameSession={onRenameSession}
              onTagSession={onTagSession}
            />
          )}
      </div>

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
