import { Button, CloseIcon, IconButton, Kbd } from '@/components/ui';
import { KindPicker } from '../KindPicker';
import { WorkModePicker } from '../WorkModePicker';
import { PermissionModePicker } from '../PermissionModePicker';
import { ModelEffortPicker } from '../ModelEffortPicker';
import { useNewTaskForm } from './NewTaskForm.hooks';
import type { NewTaskFormProps } from './NewTaskForm.types';

const INPUT_CLASS =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';

/** The create-task dialog reached from the board's "New task" affordance. */
export function NewTaskForm({ onCreate, onClose }: NewTaskFormProps) {
  const {
    title,
    description,
    kind,
    runMode,
    permissionMode,
    model,
    effort,
    maxTurns,
    maxBudget,
    busy,
    canSubmit,
    setTitle,
    setDescription,
    setKind,
    setRunMode,
    setPermissionMode,
    setModel,
    setEffort,
    setMaxTurns,
    setMaxBudget,
    submit,
    onTitleKeyDown,
    onDescKeyDown,
  } = useNewTaskForm({ onCreate, onClose });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New task"
      className="fixed inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-border bg-popover shadow-2xl"
        style={{ animation: 'nc-sheet-in .28s cubic-bezier(.22,1,.36,1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 className="flex-1 text-base font-semibold text-foreground">New task</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <CloseIcon size={16} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={onTitleKeyDown}
            placeholder="Task title"
            aria-label="Task title"
            className={INPUT_CLASS}
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={onDescKeyDown}
            rows={4}
            placeholder="Describe what you want built…"
            aria-label="Task description"
            className={`resize-none ${INPUT_CLASS}`}
          />
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Kind
            </span>
            <KindPicker value={kind} onChange={setKind} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Run mode
            </span>
            <WorkModePicker value={runMode} onChange={setRunMode} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Permission mode
            </span>
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
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                Max turns
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value)}
                placeholder="Inherit"
                aria-label="Max turns"
                className={INPUT_CLASS}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                Max budget (USD)
              </span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step={0.5}
                value={maxBudget}
                onChange={(e) => setMaxBudget(e.target.value)}
                placeholder="Inherit"
                aria-label="Max budget in USD"
                className={INPUT_CLASS}
              />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
          <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
            <Kbd>⌘↵</Kbd> to create
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? 'Creating…' : 'Create task'}
          </Button>
        </div>
      </div>
    </div>
  );
}
