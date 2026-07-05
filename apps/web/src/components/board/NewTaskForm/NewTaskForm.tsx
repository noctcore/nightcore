import {
  BranchPicker,
  Button,
  CloseIcon,
  IconButton,
  ImageDropzone,
  Kbd,
  Modal,
  ModelEffortPicker,
  slideIn,
  Spinner,
} from '@/components/ui';
import { imageDataUrl, MAX_IMAGES_PER_TASK } from '@/lib/attachments';

import { KindPicker } from '../KindPicker';
import { PermissionModePicker } from '../PermissionModePicker';
import { WorkModePicker } from '../WorkModePicker';
import { useNewTaskForm } from './NewTaskForm.hooks';
import type { NewTaskFormProps } from './NewTaskForm.types';

const INPUT_CLASS =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';
const LABEL_CLASS =
  'font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground';

/** The create-task dialog reached from the board's "New task" affordance. */
export function NewTaskForm({ open, onCreate, onClose }: NewTaskFormProps) {
  const {
    title,
    description,
    kind,
    runMode,
    branch,
    baseBranch,
    branches,
    permissionMode,
    model,
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
    setModel,
    setEffort,
    setMaxTurns,
    setMaxBudget,
    addFiles,
    removeAttachment,
    submit,
    onDescKeyDown,
    onDescPaste,
  } = useNewTaskForm({ open, onCreate, onClose });

  return (
    <Modal
      open={open}
      label="New task"
      initialFocus="#nt-title"
      onClose={onClose}
      overlayClassName="fixed inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-sm"
      panelClassName="flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-border bg-popover shadow-2xl"
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
            <PermissionModePicker value={permissionMode} onChange={setPermissionMode} />
          </div>
          <ModelEffortPicker
            model={model}
            effort={effort}
            onChangeModel={setModel}
            onChangeEffort={setEffort}
          />
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
