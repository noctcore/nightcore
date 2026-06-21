import { useCallback, useState } from 'react';
import type { RunMode, TaskKind } from '@/lib/bridge';
import type { NewTaskFormProps } from './NewTaskForm.types';

export interface NewTaskFormState {
  title: string;
  description: string;
  kind: TaskKind;
  runMode: RunMode;
  busy: boolean;
  canSubmit: boolean;
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
  setKind: (value: TaskKind) => void;
  setRunMode: (value: RunMode) => void;
  submit: () => Promise<void>;
  onTitleKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onDescKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** State, submit, and keyboard handling for the create-task dialog. */
export function useNewTaskForm({
  onCreate,
  onClose,
}: NewTaskFormProps): NewTaskFormState {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<TaskKind>('build');
  const [runMode, setRunMode] = useState<RunMode>('main');
  const [busy, setBusy] = useState(false);

  const canSubmit = title.trim().length > 0 && !busy;

  const submit = useCallback(async () => {
    if (title.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      await onCreate(title.trim(), description.trim(), kind, runMode);
      onClose();
    } finally {
      setBusy(false);
    }
  }, [title, description, kind, runMode, busy, onCreate, onClose]);

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

  return {
    title,
    description,
    kind,
    runMode,
    busy,
    canSubmit,
    setTitle,
    setDescription,
    setKind,
    setRunMode,
    submit,
    onTitleKeyDown,
    onDescKeyDown,
  };
}
