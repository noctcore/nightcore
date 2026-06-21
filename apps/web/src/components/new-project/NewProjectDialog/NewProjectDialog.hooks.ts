import { useCallback, useState } from 'react';
import type { NewProjectDialogProps } from './NewProjectDialog.types';

export interface NewProjectDialogState {
  name: string;
  model: string;
  concurrency: number;
  canCreate: boolean;
  setName: (value: string) => void;
  setModel: (value: string) => void;
  setConcurrency: (value: number) => void;
  create: () => void;
}

type UseNewProjectDialogArgs = Pick<
  NewProjectDialogProps,
  'models' | 'onCreate' | 'folder'
>;

/** Form state and the create handler for the new-project dialog. */
export function useNewProjectDialog({
  models,
  onCreate,
  folder = null,
}: UseNewProjectDialogArgs): NewProjectDialogState {
  const [name, setName] = useState('');
  const [model, setModel] = useState(models[0] ?? '');
  const [concurrency, setConcurrency] = useState(3);

  const canCreate = folder !== null && name.trim().length > 0;

  const create = useCallback(() => {
    if (!canCreate) return;
    void onCreate({ folder, name: name.trim(), model, concurrency });
  }, [canCreate, folder, name, model, concurrency, onCreate]);

  return {
    name,
    model,
    concurrency,
    canCreate,
    setName,
    setModel,
    setConcurrency,
    create,
  };
}
