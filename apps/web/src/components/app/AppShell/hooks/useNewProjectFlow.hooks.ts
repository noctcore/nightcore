import { useCallback, useState } from 'react';

import type { NewProjectDraft } from '@/components/new-project/NewProjectDialog/NewProjectDialog.types';
import type { ToastApi } from '@/components/ui';
import {
  chooseFolder,
  createProject,
  gitInit,
  isGitRepo,
  saveProjectIcon,
  setProjectIcon,
} from '@/lib/bridge';
import { invalidateProjectIconCache } from '@/lib/useProjectIconUrl';

/** Git-repo status for the folder chosen in the New Project dialog. */
type GitState = 'unknown' | 'checking' | 'valid' | 'invalid';

/** The New Project flow: native folder pick → git-repo check → optional
 *  `git init` → `create_project` (which activates it). */
export function useNewProjectFlow(onClose: () => void, toast: ToastApi) {
  const [folder, setFolder] = useState<string | null>(null);
  const [gitState, setGitState] = useState<GitState>('unknown');

  const reset = useCallback(() => {
    setFolder(null);
    setGitState('unknown');
  }, []);

  const pickFolder = useCallback(async () => {
    const chosen = await chooseFolder();
    if (chosen === null) return;
    setFolder(chosen);
    setGitState('checking');
    const ok = await isGitRepo(chosen).catch(() => false);
    setGitState(ok ? 'valid' : 'invalid');
  }, []);

  const initGit = useCallback(async () => {
    if (folder === null) return;
    try {
      await gitInit(folder);
      setGitState('valid');
    } catch (err) {
      console.error('git_init failed', err);
      toast.error('Could not initialize a git repository', err);
    }
  }, [folder, toast]);

  const create = useCallback(
    async (draft: NewProjectDraft) => {
      if (draft.folder === null) return;
      const project = await createProject(draft.folder, draft.name).catch((err) => {
        console.error('create_project failed', err);
        toast.error('Could not create project', err);
        throw err;
      });

      try {
        if (draft.customImage !== null) {
          await saveProjectIcon(project.id, {
            format: draft.customImage.format as 'png' | 'jpeg' | 'webp' | 'gif',
            data: draft.customImage.data,
            filename: draft.customImage.filename,
          });
        } else if (draft.icon !== null) {
          await setProjectIcon(project.id, draft.icon);
        }
        invalidateProjectIconCache(project.id);
      } catch (err) {
        console.error('save new project icon failed', err);
        toast.error('Project created, but its icon could not be saved', err);
      }

      reset();
      onClose();
    },
    [onClose, reset, toast],
  );

  const createDefault = useCallback(
    (name: string) =>
      create({
        folder,
        name,
        icon: null,
        customImage: null,
      }),
    [create, folder],
  );

  return { folder, gitState, pickFolder, initGit, create, createDefault, reset };
}
