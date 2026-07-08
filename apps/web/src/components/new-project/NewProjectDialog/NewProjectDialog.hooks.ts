/** Form state and create logic for the new-project dialog. */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProjectIconImageDraft } from '@/components/ui';

import type { NewProjectDialogProps } from './NewProjectDialog.types';

/** Derive a repository display name from either Windows or POSIX paths. */
export function projectNameFromPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.at(-1)?.toLowerCase() === '.git') segments.pop();
  return segments.at(-1) ?? '';
}

/** Form values, derived flags, and setters returned by `useNewProjectDialog`. */
export interface NewProjectDialogState {
  name: string;
  icon: string | null;
  pendingImage: ProjectIconImageDraft | null;
  canCreate: boolean;
  /** True while a create is in flight — disables the button to block double-submit. */
  busy: boolean;
  setName: (value: string) => void;
  setIcon: (value: string | null) => void;
  setPendingImage: (value: NewProjectDialogState['pendingImage']) => void;
  create: () => void;
}

type UseNewProjectDialogArgs = Pick<
  NewProjectDialogProps,
  'open' | 'onCreate' | 'folder' | 'gitState'
>;

/** Form state and the create handler for the new-project dialog. Creation is
 *  gated on a chosen folder, a non-empty name, and a valid git repo. */
export function useNewProjectDialog({
  open,
  onCreate,
  folder = null,
  gitState = 'unknown',
}: UseNewProjectDialogArgs): NewProjectDialogState {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<ProjectIconImageDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const nameEditedRef = useRef(false);

  // The dialog now stays mounted across close so its exit can animate — reset the
  // form each time it opens, otherwise a cancelled draft would reappear on reopen.
  useEffect(() => {
    if (!open) return;
    setName('');
    nameEditedRef.current = false;
    setIcon(null);
    setPendingImage(null);
  }, [open]);

  useEffect(() => {
    if (!open || folder === null || nameEditedRef.current) return;
    setName(projectNameFromPath(folder));
  }, [folder, open]);

  const updateName = useCallback((value: string) => {
    nameEditedRef.current = true;
    setName(value);
  }, []);

  // Esc / click-outside (suppressed while busy) and the focus trap live in the
  // shared `<Modal>` the dialog renders through — the double-submit guard is
  // preserved by passing a no-op close while a create is in flight.
  const canCreate =
    folder !== null && name.trim().length > 0 && gitState === 'valid' && !busy;

  const create = useCallback(() => {
    // Guard against a double-submit: re-entry while a create is already in flight
    // is a no-op (the second click would register a duplicate project).
    if (!canCreate || busy) return;
    setBusy(true);
    void Promise.resolve(
      onCreate({
        folder,
        name: name.trim(),
        icon: pendingImage === null ? icon : null,
        customImage: pendingImage,
      }),
    ).finally(() => setBusy(false));
  }, [canCreate, busy, folder, name, icon, pendingImage, onCreate]);

  return {
    name,
    icon,
    pendingImage,
    canCreate,
    busy,
    setName: updateName,
    setIcon,
    setPendingImage,
    create,
  };
}
