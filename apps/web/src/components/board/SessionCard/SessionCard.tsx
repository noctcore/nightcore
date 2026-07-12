/** The collapsible Session and History cards plus the GroupLabel divider used in
 *  the task-detail drawer. */
import type { ReactNode } from 'react';

import {
  BoltIcon,
  ChevronDownIcon,
  HistoryIcon,
  ModelSelectField,
  useProviderCapabilities,
} from '@/components/ui';
import type { Task } from '@/lib/bridge';
import { parseNumericCommit } from '@/lib/numeric-field';

import { type TaskDetailActions, useTaskActions } from '../actions';
import { KindPicker } from '../KindPicker';
import { PermissionModePicker } from '../PermissionModePicker';
import { SessionHistory } from '../SessionHistory';
import {
  KIND_LABEL,
  modelBadge,
  PERMISSION_MODE_LABEL,
  RUN_MODE_LABEL,
} from '../status';
import { WorkModePicker } from '../WorkModePicker';
import { summarizeSession,useHistoryCard, useSessionCard } from './SessionCard.hooks';
import type { HistoryCardProps, SessionCardProps } from './SessionCard.types';

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
      <span className="font-mono text-4xs uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-black/20 px-2 py-1 focus-within:border-primary">
        {prefix !== undefined && (
          <span className="font-mono text-2xs text-muted-foreground">{prefix}</span>
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
          className="w-full bg-transparent font-mono text-2xs-plus text-foreground outline-none placeholder:text-muted-foreground/60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </span>
    </label>
  );
}

/** A labeled control row inside the expanded Session card. The two-column
 *  `[5.5rem_1fr]` grid keeps the config sections in a compact aligned form, each
 *  with an `<h3>` label. */
function SessionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-x-3 gap-y-1">
      <h3 className="pt-1 font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </h3>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A read-only config value pill — the post-run, un-editable rendering of a
 *  session setting. Shared by the readonly Session body's identical mono pills. */
function ConfigPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-2xs text-muted-foreground">
      {children}
    </span>
  );
}

/** The editable Session body — the live pickers shown while a task is still
 *  pre-run (backlog/ready). Renders the kind/run-mode/permission/model-effort
 *  pickers and the limit fields. */
function EditableSessionBody({
  task,
  onChangeKind,
  onChangeRunMode,
  onChangePermissionMode,
  onChangeModel,
  onChangeProvider,
  onChangeEffort,
  onChangeMaxTurns,
  onChangeMaxBudget,
}: {
  task: Task;
  onChangeKind: NonNullable<TaskDetailActions['onChangeKind']>;
  onChangeRunMode: NonNullable<TaskDetailActions['onChangeRunMode']>;
  onChangePermissionMode: NonNullable<TaskDetailActions['onChangePermissionMode']>;
  onChangeModel: NonNullable<TaskDetailActions['onChangeModel']>;
  onChangeProvider: NonNullable<TaskDetailActions['onChangeProvider']>;
  onChangeEffort: NonNullable<TaskDetailActions['onChangeEffort']>;
  onChangeMaxTurns: NonNullable<TaskDetailActions['onChangeMaxTurns']>;
  onChangeMaxBudget: NonNullable<TaskDetailActions['onChangeMaxBudget']>;
}) {
  const capabilities = useProviderCapabilities();
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
          supportedAutonomyLevels={capabilities?.autonomyLevels}
        />
      </SessionRow>
      <SessionRow label="Model & effort">
        <ModelSelectField
          value={{ model: task.model, effort: task.effort, providerId: task.providerId }}
          onChange={(sel) => {
            // A single pick can move model + its provider stamp + a reconciled
            // effort; patch only the fields that actually changed.
            if (sel.model !== task.model) onChangeModel(task.id, sel.model);
            if (sel.providerId !== task.providerId) onChangeProvider(task.id, sel.providerId);
            if (sel.effort !== task.effort) onChangeEffort(task.id, sel.effort);
          }}
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
 *  as static `ConfigPill`s. */
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
          {/* Prefer the model the run ACTUALLY used over the requested override (which
              is null for "inherit"), so a post-run config reads honestly (T13). */}
          <ConfigPill>{modelBadge(task).label}</ConfigPill>
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

/** The collapsible Session card: a middot summary line that expands to reveal the
 *  config pickers (editable) or read-only pills (post-run). Opens on mount when the
 *  task is still editable so a fresh backlog/ready task surfaces its config without
 *  a click; otherwise collapsed. */
export function SessionCard({ task, kindEditable }: SessionCardProps) {
  const { open, toggle } = useSessionCard(kindEditable);
  const {
    onChangeKind,
    onChangeRunMode,
    onChangePermissionMode,
    onChangeModel,
    onChangeProvider,
    onChangeEffort,
    onChangeMaxTurns,
    onChangeMaxBudget,
  } = useTaskActions();

  // A task is editable here only while still pre-run (`kindEditable`) AND the
  // shell wired every edit handler (it always passes them together).
  const editable =
    kindEditable &&
    onChangeKind !== undefined &&
    onChangeRunMode !== undefined &&
    onChangePermissionMode !== undefined &&
    onChangeModel !== undefined &&
    onChangeProvider !== undefined &&
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
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
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
                onChangeProvider={onChangeProvider}
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
export function HistoryCard({ task, canResume }: HistoryCardProps) {
  const { open, toggle } = useHistoryCard();
  const actions = useTaskActions();
  // The parent only renders this card once these handlers are wired, so the
  // non-null assertions hold; they keep the leaf control props non-optional.
  const onResume = actions.onResumeSession!;
  const onRename = actions.onRenameSession!;
  const onTag = actions.onTagSession!;
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
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
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
              onResume={onResume}
              onRename={onRename}
              onTag={onTag}
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
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="font-mono text-3xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {children}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
