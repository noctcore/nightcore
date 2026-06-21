import { useCallback, useState } from 'react';
import type { NewTaskFormProps } from './NewTaskForm.types';

export interface NewTaskFormState {
  title: string;
  description: string;
  busy: boolean;
  canSubmit: boolean;
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
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

  return {
    title,
    description,
    busy,
    canSubmit,
    setTitle,
    setDescription,
    submit,
    onTitleKeyDown,
    onDescKeyDown,
  };
}
