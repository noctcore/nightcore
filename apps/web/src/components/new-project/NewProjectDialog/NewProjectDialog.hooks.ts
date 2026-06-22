import { useCallback, useState } from 'react';
import type { NewProjectDialogProps } from './NewProjectDialog.types';

export interface NewProjectDialogState {
  name: string;
  model: string;
  concurrency: number;
  canCreate: boolean;
  /** True while a create is in flight — disables the button to block double-submit. */
  busy: boolean;
  setName: (value: string) => void;
  setModel: (value: string) => void;
  setConcurrency: (value: number) => void;
  create: () => void;
}

type UseNewProjectDialogArgs = Pick<
  NewProjectDialogProps,
  'models' | 'onCreate' | 'folder' | 'gitState'
>;

/** Form state and the create handler for the new-project dialog. Creation is
 *  gated on a chosen folder, a non-empty name, and a valid git repo. */
export function useNewProjectDialog({
  models,
  onCreate,
  folder = null,
  gitState = 'unknown',
}: UseNewProjectDialogArgs): NewProjectDialogState {
  const [name, setName] = useState('');
  const [model, setModel] = useState(models[0] ?? '');
  const [concurrency, setConcurrency] = useState(3);
  const [busy, setBusy] = useState(false);

  // Esc / click-outside (suppressed while busy) and the focus trap now live in
  // the shared `<Modal>` the dialog renders through — W-A's double-submit guard
  // is preserved by passing a no-op close while a create is in flight.
  const canCreate =
    folder !== null && name.trim().length > 0 && gitState === 'valid' && !busy;

  const create = useCallback(() => {
    // Guard against a double-submit: re-entry while a create is already in flight
    // is a no-op (the second click would register a duplicate project).
    if (!canCreate || busy) return;
    setBusy(true);
    void Promise.resolve(onCreate({ folder, name: name.trim(), model, concurrency })).finally(
      () => setBusy(false),
    );
  }, [canCreate, busy, folder, name, model, concurrency, onCreate]);

  return {
    name,
    model,
    concurrency,
    canCreate,
    busy,
    setName,
    setModel,
    setConcurrency,
    create,
  };
}
