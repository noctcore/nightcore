import { useCallback, useState } from 'react';

interface NewTaskFormProps {
  onCreate: (title: string, description: string) => Promise<void>;
  onClose: () => void;
}

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
      className="fixed inset-0 z-20 flex items-start justify-center bg-black/50 px-4 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-zinc-200">New task</h2>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onTitleKeyDown}
          placeholder="Task title"
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onDescKeyDown}
          rows={4}
          placeholder="Describe the task…  (⌘/Ctrl+Enter to create)"
          className="mt-2 w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white enabled:hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </div>
    </div>
  );
}
