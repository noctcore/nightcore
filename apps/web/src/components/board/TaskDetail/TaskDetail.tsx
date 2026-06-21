import {
  BranchIcon,
  Button,
  CheckIcon,
  CloseIcon,
  CommitIcon,
  IconButton,
  Markdown,
  RefineIcon,
  TerminalIcon,
} from '@/components/ui';
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
import { TaskStatusDot } from '../TaskStatusDot';
import { PermissionPrompt } from '../PermissionPrompt';
import { KindPicker } from '../KindPicker';
import { WorkModePicker } from '../WorkModePicker';
import { PermissionModePicker } from '../PermissionModePicker';
import { ModelEffortPicker } from '../ModelEffortPicker';
import { ReviewPanel } from '../ReviewPanel';
import { GauntletResults } from '../GauntletResults';
import { canMerge, deriveTaskDetailView } from './TaskDetail.hooks';
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

/** The logs / detail drawer — title, status, kind, plan, parked permission
 *  prompts, the reviewer verdict + verification controls (M4), the readiness
 *  gauntlet + verified-gated merge, the transcript, and the per-status run /
 *  approval controls. */
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
    answer,
    tools,
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

        <section>
          <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Kind
          </h3>
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
        </section>

        <section>
          <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Run mode
          </h3>
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
        </section>

        <section>
          <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Permission mode
          </h3>
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
        </section>

        <section>
          <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Model &amp; effort
          </h3>
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
        </section>

        <section>
          <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Limits
          </h3>
          {kindEditable && onChangeMaxTurns !== undefined && onChangeMaxBudget !== undefined ? (
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
        </section>

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

        {tools.length > 0 && (
          <section>
            <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Tools
            </h3>
            <ul className="space-y-1">
              {tools.map((tool) => (
                <li
                  key={tool.id}
                  className="flex items-start gap-1.5 font-mono text-xs text-primary/80"
                >
                  <TerminalIcon size={12} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    <span className="font-semibold">{tool.toolName}</span>
                    {tool.input !== undefined && (
                      <span className="text-muted-foreground"> · {summarizeInput(tool.input)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex-1">
          <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            {isRunning ? 'Live transcript' : 'Transcript'}
          </h3>
          {error !== null ? (
            <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/[0.12] px-3 py-2 font-mono text-xs text-destructive">
              {error}
            </pre>
          ) : answer.length > 0 ? (
            <div className="text-foreground">
              <Markdown>{answer}</Markdown>
              {isRunning && <span className="text-muted-foreground">▌</span>}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {isRunning
                ? 'Waiting for first token…'
                : 'No output yet — run this task to stream its transcript.'}
            </p>
          )}
        </section>
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
