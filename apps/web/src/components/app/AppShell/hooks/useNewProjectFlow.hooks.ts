import { useCallback, useState } from 'react';

import type { ToastApi } from '@/components/ui';
import { chooseFolder, createProject, gitInit, isGitRepo } from '@/lib/bridge';

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
    async (path: string, name: string) => {
      await createProject(path, name).catch((err) => {
        console.error('create_project failed', err);
        toast.error('Could not create project', err);
        throw err;
      });
      reset();
      onClose();
    },
    [onClose, reset, toast],
  );

  return { folder, gitState, pickFolder, initGit, create, reset };
}
