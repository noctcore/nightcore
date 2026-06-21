import {
  BoltIcon,
  BranchIcon,
  Button,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CommitIcon,
  IconButton,
  LogsIcon,
  Markdown,
  RefineIcon,
  TerminalIcon,
} from '@/components/ui';
import type { Task } from '@/lib/bridge';
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
import {
  canMerge,
  deriveTaskDetailView,
  summarizeSession,
  useSessionCard,
} from './TaskDetail.hooks';
import type { TaskDetailProps } from './TaskDetail.types';

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
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < min || parsed === value) return;
    onCommit(parsed);
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
        style={open ? { animation: 'nc-rise .16s cubic-bezier(.22,1,.36,1)' } : undefined}
      >
        {open && (
          <div className="grid gap-3 border-t border-border px-3 pb-3 pt-3">
            <SessionRow label="Kind">
              {kindEditable && onChangeKind !== undefined ? (
                <KindPicker
                  compact
                  value={task.kind}
                  onChange={(kind) => onChangeKind(task.id, kind)}
                />
              ) : (
                <span className="inline-flex items-center rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {KIND_LABEL[task.kind]}
                </span>
              )}
            </SessionRow>

            <SessionRow label="Run mode">
              {kindEditable && onChangeRunMode !== undefined ? (
                <WorkModePicker
                  value={task.runMode}
                  onChange={(runMode) => onChangeRunMode(task.id, runMode)}
                />
              ) : (
                <span className="inline-flex items-center rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {RUN_MODE_LABEL[task.runMode]}
                </span>
              )}
            </SessionRow>

            <SessionRow label="Permission">
              {kindEditable && onChangePermissionMode !== undefined ? (
                <PermissionModePicker
                  value={task.permissionMode}
                  onChange={(mode) => onChangePermissionMode(task.id, mode)}
                />
              ) : (
                <span className="inline-flex items-center rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {task.permissionMode !== null
                    ? PERMISSION_MODE_LABEL[task.permissionMode]
                    : 'Inherit'}
                </span>
              )}
            </SessionRow>

            <SessionRow label="Model & effort">
              {kindEditable && onChangeModel !== undefined && onChangeEffort !== undefined ? (
                <ModelEffortPicker
                  model={task.model}
                  effort={task.effort}
                  onChangeModel={(model) => onChangeModel(task.id, model)}
                  onChangeEffort={(effort) => onChangeEffort(task.id, effort)}
                />
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {task.model !== null ? modelDisplayName(task.model) : 'Model: inherit'}
                  </span>
                  <span className="inline-flex items-center rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    Effort: {task.effort ?? 'inherit'}
                  </span>
                </div>
              )}
            </SessionRow>

            <SessionRow label="Limits">
              {kindEditable &&
              onChangeMaxTurns !== undefined &&
              onChangeMaxBudget !== undefined ? (
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
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    Turns: {task.maxTurns ?? 'inherit'}
                  </span>
                  <span className="inline-flex items-center rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    Budget: {task.maxBudgetUsd !== null ? `$${task.maxBudgetUsd}` : 'inherit'}
                  </span>
                </div>
              )}
            </SessionRow>
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
          {entries.map((entry, i) =>
            entry.kind === 'text' ? (
              <li key={`t${i}`} className="text-foreground">
                <Markdown>{entry.markdown}</Markdown>
                {isRunning && i === entries.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="ml-0.5 inline-block w-[2px] animate-[nc-pulse_1s_ease-in-out_infinite] align-text-bottom text-primary"
                  >
                    ▌
                  </span>
                )}
              </li>
            ) : (
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
            ),
          )}
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
      </div>

      <footer className="flex items-center gap-2 border-t border-border bg-card px-4 py-3">
        {planParked ? (
          <>
            <Button onClick={() => onApprove?.(task.id)}>
              <CheckIcon size={14} />
              Approve
            </Button>
            <Button variant="secondary" onClick={() => onRefine?.(task.id)}>
              <RefineIcon size={14} />
              Refine
            </Button>
            <span className="flex-1" />
            <Button variant="danger" onClick={() => onReject?.(task.id)}>
              Reject
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
                disabled={!mergeable}
                title={
                  mergeable
                    ? undefined
                    : 'Merge needs a verified task and a passing gauntlet — run the checks first'
                }
              >
                <BranchIcon size={14} />
                Merge
              </Button>
            ) : (
              <Button onClick={() => onCommit?.(task.id)}>
                <CommitIcon size={14} />
                Commit
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
                disabled={anyRunning}
                title={anyRunning ? 'Another task is already running' : undefined}
              >
                Run
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
