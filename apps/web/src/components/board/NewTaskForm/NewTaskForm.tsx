import {
  AlertIcon,
  BranchPicker,
  Button,
  CloseIcon,
  IconButton,
  ImageDropzone,
  Kbd,
  Modal,
  ModelSelectField,
  slideIn,
  Spinner,
  Toggle,
  useProviderCapabilities,
} from '@/components/ui';
import { imageDataUrl, MAX_IMAGES_PER_TASK } from '@/lib/attachments';
import { capabilitiesForProvider } from '@/lib/provider-capabilities';

import { KindPicker } from '../KindPicker';
import { PermissionModePicker } from '../PermissionModePicker';
import { WorkModePicker } from '../WorkModePicker';
import { useNewTaskForm } from './NewTaskForm.hooks';
import type { NewTaskFormProps } from './NewTaskForm.types';

const INPUT_CLASS =
  'w-full rounded-nc border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';
const LABEL_CLASS =
  'font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground';

/** The create-task dialog reached from the board's "New task" affordance. */
export function NewTaskForm({ open, planGateDefault, onCreate, onClose }: NewTaskFormProps) {
  const capabilities = useProviderCapabilities();
  const {
    title,
    description,
    kind,
    runMode,
    branch,
    baseBranch,
    branches,
    permissionMode,
    planFirst,
    providerSupportsPlanGate,
    governanceWarning,
    runCeilingCaveat,
    model,
    providerId,
    effort,
    maxTurns,
    maxBudget,
    attachments,
    attachError,
    busy,
    error,
    canSubmit,
    setTitle,
    setDescription,
    setKind,
    setRunMode,
    setBranch,
    setBaseBranch,
    setPermissionMode,
    setPlanFirst,
    setModel,
    setProviderId,
    setEffort,
    setMaxTurns,
    setMaxBudget,
    addFiles,
    removeAttachment,
    submit,
    onDescKeyDown,
    onDescPaste,
  } = useNewTaskForm({ open, planGateDefault, onCreate, onClose });

  return (
    <Modal
      open={open}
      label="New task"
      initialFocus="#nt-title"
      onClose={onClose}
      overlayClassName="fixed inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-sm"
      variant="sheet"
      panelClassName="max-w-lg"
      panelVariants={slideIn}
    >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 className="flex-1 text-base font-semibold text-foreground">New task</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <CloseIcon size={16} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="nt-title" className={LABEL_CLASS}>
              Title
            </label>
            <input
              id="nt-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              className={INPUT_CLASS}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="nt-description" className={LABEL_CLASS}>
              Description
            </label>
            <textarea
              id="nt-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={onDescKeyDown}
              onPaste={onDescPaste}
              rows={4}
              placeholder="Describe what you want built…"
              className={`resize-none ${INPUT_CLASS}`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={LABEL_CLASS}>Images</span>
            <ImageDropzone
              items={attachments.map((a) => ({
                id: a.tempId,
                filename: a.filename,
                previewUrl: imageDataUrl(a.format, a.data),
                size: a.size,
              }))}
              onAddFiles={(files) => void addFiles(files)}
              onRemove={removeAttachment}
              canAddMore={attachments.length < MAX_IMAGES_PER_TASK}
              error={attachError}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={LABEL_CLASS}>Kind</span>
            <KindPicker value={kind} onChange={setKind} />
          </div>
          {/* Plan-approval gate (T6, #147): review a plan before the agent writes
              code. Seeded from the kind + the global default (Build defaults on);
              overridable per task — force it on any kind, or skip it for a trivial
              Build task. On a provider without the plan-approval channel (no hooks,
              e.g. Codex) the toggle is non-interactive so a plan can't be forced into a
              silent no-op. */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className={LABEL_CLASS}>Plan first</span>
              <span className="text-2xs leading-snug text-muted-foreground">
                {providerSupportsPlanGate
                  ? 'Review a plan before the agent writes code'
                  : 'Plan approval isn’t supported on this provider'}
              </span>
            </div>
            {providerSupportsPlanGate ? (
              <Toggle
                on={planFirst}
                onChange={setPlanFirst}
                label="Plan first — review a plan before the agent writes code"
              />
            ) : (
              <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground/60">
                Unavailable
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={LABEL_CLASS}>Run mode</span>
            <WorkModePicker value={runMode} onChange={setRunMode} />
          </div>
          {runMode === 'worktree' && (
            <>
              <div className="flex flex-col gap-1.5">
                <span className={LABEL_CLASS}>Branch</span>
                <BranchPicker
                  value={branch}
                  onChange={setBranch}
                  branches={branches}
                  placeholder="nc/<task-id> · default"
                  ariaLabel="Worktree branch"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className={LABEL_CLASS}>Base branch</span>
                <BranchPicker
                  value={baseBranch}
                  onChange={setBaseBranch}
                  branches={branches}
                  allowCreate={false}
                  placeholder="Current branch · default"
                  ariaLabel="Base branch"
                />
              </div>
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <span className={LABEL_CLASS}>Permission mode</span>
            <PermissionModePicker
              value={permissionMode}
              onChange={setPermissionMode}
              supportedAutonomyLevels={
                capabilitiesForProvider(providerId, capabilities)?.autonomyLevels
              }
            />
          </div>
          <ModelSelectField
            value={{ model, effort, providerId }}
            onChange={(sel) => {
              setModel(sel.model);
              setProviderId(sel.providerId);
              setEffort(sel.effort);
            }}
          />
          {/* Governance mismatch warning (#296): this project's Harness policy is
              armed but the picked provider can't enforce it (or can't write the
              audit ledger) — the engine refuses the run before it starts
              (`assertGovernanceInvariant`). Surfaced here so that refusal isn't a
              surprise after Create. */}
          {governanceWarning !== null && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-nc border border-warning/40 bg-warning/[0.08] px-3 py-2.5"
            >
              <AlertIcon size={15} className="mt-0.5 shrink-0 text-warning" />
              <p className="flex-1 text-xs-plus leading-snug text-warning">
                {governanceWarning}
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="nt-max-turns" className={LABEL_CLASS}>
                Max turns
              </label>
              <input
                id="nt-max-turns"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value)}
                placeholder="Inherit"
                className={INPUT_CLASS}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="nt-max-budget" className={LABEL_CLASS}>
                Max budget (USD)
              </label>
              <input
                id="nt-max-budget"
                type="number"
                inputMode="decimal"
                min={0}
                step={0.5}
                value={maxBudget}
                onChange={(e) => setMaxBudget(e.target.value)}
                placeholder="Inherit"
                className={INPUT_CLASS}
              />
            </div>
          </div>
          {/* Run-ceiling caveat (#296 item 5): the picked provider (e.g. Codex)
              can't enforce these limits — its SDK has no turn/budget ceiling — so
              they'd be silently ignored. Shown only when the resolved provider
              declares them unsupported; the controls stay (they work for Claude). */}
          {runCeilingCaveat !== null && (
            <p className="text-3xs leading-snug text-muted-foreground">{runCeilingCaveat}</p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
          {error !== null ? (
            <span role="alert" className="mr-auto min-w-0 truncate text-xs text-destructive">
              {error}
            </span>
          ) : (
            <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
              <Kbd>⌘↵</Kbd> to create
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} aria-busy={busy}>
            {busy ? <Spinner /> : null}
            {busy ? 'Creating…' : 'Create task'}
          </Button>
        </div>
    </Modal>
  );
}
