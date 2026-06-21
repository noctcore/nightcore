import { useCallback, useState } from 'react';
import { Button, IconButton, Kbd } from '../../shared/ui';

interface NewTaskFormProps {
  onCreate: (title: string, description: string) => Promise<void>;
  onClose: () => void;
}

const INPUT_CLASS =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';

/** The create-task dialog reached from the board's "New task" affordance. */
export function NewTaskForm({ onCreate, onClose }: NewTaskFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit = title.trim().length > 0 && !busy;

  const submit = useCallback(async () => {
    if (title.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      await onCreate(title.trim(), description.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  }, [title, description, busy, onCreate, onClose]);

  const onTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  const onDescKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    },
    [onClose, submit],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New task"
      className="fixed inset-0 z-20 flex items-start justify-center bg-black/60 px-4 pt-24 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
        style={{ animation: 'nc-rise .22s cubic-bezier(.22,1,.36,1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 className="flex-1 text-base font-semibold text-foreground">New task</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            ✕
          </IconButton>
        </div>
        <div className="flex flex-col gap-3 p-5">
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
