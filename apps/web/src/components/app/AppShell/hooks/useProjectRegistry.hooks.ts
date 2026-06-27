import { useCallback, useEffect, useState } from 'react';
import {
  activeProject,
  deleteProject,
  listProjects,
  onProjectEvent,
  renameProject,
  setActiveProject,
  type Project,
} from '@/lib/bridge';
import type { ToastApi } from '@/components/ui';
import { useAsyncData } from './useAsyncData.hooks';

/** Cap on the initial registry read. A wedged core could leave the `invoke` pending
 *  forever; since the boot splash now waits on `loaded`, that would hang the app on
 *  the splash. On timeout we resolve to an empty registry so the shell lands on the
 *  (empty) Projects surface instead of an indefinite "loading workspace…". */
const BOOT_LOAD_TIMEOUT_MS = 6000;

/** The project registry + active project, kept in sync via `nc:project`. */
export function useProjectRegistry(toast: ToastApi) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<Project | null>(null);
  // `loaded` flips true once the initial registry read settles (success OR handled
  // failure). The shell holds the boot splash until then so the first paint already
  // knows whether to land on the full-screen Projects view (no active project) or a
  // restored project's board — no flash of the wrong surface.
  const [loaded, setLoaded] = useState(false);

  useAsyncData(
    () =>
      Promise.race([
        Promise.all([listProjects(), activeProject()]).catch((err) => {
          console.error('load projects failed', err);
          toast.error('Could not load projects', err);
          return [[], null] as [Project[], Project | null];
        }),
        new Promise<[Project[], Project | null]>((resolve) =>
          setTimeout(() => resolve([[], null]), BOOT_LOAD_TIMEOUT_MS),
        ),
      ]),
    ([list, current]) => {
      setProjects(list);
      setActive(current);
      setLoaded(true);
    },
  );

  useEffect(() => {
    const unlisten = onProjectEvent(({ project, projects: next, type }) => {
      setProjects(next);
      if (type === 'activated' && project !== null) setActive(project);
      if (type === 'deleted') setActive((cur) => next.find((p) => p.id === cur?.id) ?? null);
      // A rename of the active project must refresh its label (its id is unchanged).
      if (type === 'renamed' && project !== null) {
        setActive((cur) => (cur?.id === project.id ? project : cur));
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const activate = useCallback(
    (id: string) => {
      void setActiveProject(id).catch((err) => {
        console.error('set_active_project failed', err);
        toast.error('Could not open project', err);
      });
    },
    [toast],
  );

  const remove = useCallback(
    (id: string) => {
      void deleteProject(id).catch((err) => {
        console.error('delete_project failed', err);
        toast.error('Could not delete project', err);
      });
    },
    [toast],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      void renameProject(id, name).catch((err) => {
        console.error('rename_project failed', err);
        toast.error('Could not rename project', err);
      });
    },
    [toast],
  );

  return { projects, active, loaded, activate, remove, rename };
}
