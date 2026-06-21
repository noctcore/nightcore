import { Badge, Button, IconButton } from '@/components/ui';
import { useNewProjectDialog } from './NewProjectDialog.hooks';
import type { NewProjectDialogProps } from './NewProjectDialog.types';

const FIELD_LABEL =
  'mb-1.5 block text-[11.5px] font-semibold text-muted-foreground';
const FIELD_INPUT =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary';

/** The "New project" dialog — point Nightcore at a git repo. Concurrency is an
 *  M2 affordance; it's collected here but tagged accordingly. */
export function NewProjectDialog({
  models,
  onChooseFolder,
  onCreate,
  onClose,
  folder = null,
}: NewProjectDialogProps) {
  const { name, model, concurrency, canCreate, setName, setModel, setConcurrency, create } =
    useNewProjectDialog({ models, onCreate, folder });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New project"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-full overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
        style={{ animation: 'nc-rise .22s cubic-bezier(.22,1,.36,1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] bg-primary/[0.14] text-primary">
            📁
          </div>
          <div className="flex-1">
            <div className="text-base font-semibold">New project</div>
            <div className="text-xs text-muted-foreground">
              Point Nightcore at a git repo to begin.
            </div>
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            ✕
          </IconButton>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <div>
            <label className={FIELD_LABEL}>Repository folder</label>
            <button
              type="button"
              onClick={() => void onChooseFolder()}
              className={`flex w-full items-center gap-2.5 rounded-[10px] border border-dashed bg-white/[0.02] px-3 py-2.5 text-left ${folder !== null ? 'border-border' : 'border-primary/50'}`}
            >
              <span className="text-muted-foreground">📁</span>
              <span
                className={`flex-1 truncate font-mono text-[13px] ${folder !== null ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                {folder ?? 'No folder selected'}
              </span>
              <span className="text-sm font-semibold text-primary">Choose…</span>
            </button>
          </div>

          <div>
            <label className={FIELD_LABEL} htmlFor="np-name">
              Project name
            </label>
            <input
              id="np-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              className={FIELD_INPUT}
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className={FIELD_LABEL} htmlFor="np-model">
                Default model
              </label>
              <select
                id="np-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={`${FIELD_INPUT} cursor-pointer appearance-none`}
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-[120px]">
              <label className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-muted-foreground">
                Concurrency
                <Badge tone="roadmap">M2</Badge>
              </label>
              <input
                type="number"
                min={1}
                max={6}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className={`${FIELD_INPUT} font-mono`}
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2.5 border-t border-border bg-black/15 px-5 py-3.5">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!canCreate}>
            Create project
          </Button>
        </div>
      </div>
    </div>
  );
}
