import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  activeProject,
  cancelTask,
  chooseFolder,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getSettings,
  gitInit,
  isGitRepo,
  isTauri,
  listProjects,
  listTasks,
  onLoopEvent,
  onProjectEvent,
  onSessionEvent,
  onTaskEvent,
  resumeAutoLoop,
  runTask,
  setActiveProject,
  setMaxConcurrency,
  startAutoLoop,
  stopAutoLoop,
  updateSettings,
  type LoopEnvelope,
  type Project,
  type Settings,
  type SettingsPatch,
  type Task,
  type TaskStatus,
} from '@/lib/bridge';
import {
  EMPTY_STREAM,
  foldSession,
  type BreakerInfo,
  type SessionStream,
} from '@/components/board';
import type { AppView } from './AppShell.types';

/** A brief boot splash on first mount, per the design. Skipped outside Tauri so
 *  Storybook/dev renders the shell immediately. */
function useSplash() {
  const [showSplash, setShowSplash] = useState(isTauri());
  useEffect(() => {
    if (!showSplash) return;
    const timer = setTimeout(() => setShowSplash(false), 1400);
    return () => clearTimeout(timer);
  }, [showSplash]);
  return showSplash;
}

/** Routing + overlay open/close state for the shell. */
function useRouting() {
  const [view, setView] = useState<AppView>('board');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const goto = useCallback((next: AppView) => {
    setView(next);
    setSwitcherOpen(false);
  }, []);

  return {
    view,
    goto,
    switcherOpen,
    toggleSwitcher: useCallback(() => setSwitcherOpen((v) => !v), []),
    closeSwitcher: useCallback(() => setSwitcherOpen(false), []),
    newProjectOpen,
    openNewProject: useCallback(() => {
      setNewProjectOpen(true);
      setSwitcherOpen(false);
    }, []),
    closeNewProject: useCallback(() => setNewProjectOpen(false), []),
    newTaskOpen,
    openNewTask: useCallback(() => setNewTaskOpen(true), []),
    closeNewTask: useCallback(() => setNewTaskOpen(false), []),
    collapsed,
    toggleCollapsed: useCallback(() => {
      setCollapsed((v) => !v);
      setSwitcherOpen(false);
    }, []),
  };
}

/** The project registry + active project, kept in sync via `nc:project`. */
function useProjectRegistry() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<Project | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([listProjects(), activeProject()]).then(([list, current]) => {
      if (!alive) return;
      setProjects(list);
      setActive(current);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const unlisten = onProjectEvent(({ project, projects: next, type }) => {
      setProjects(next);
      if (type === 'activated' && project !== null) setActive(project);
      if (type === 'deleted') setActive((cur) => next.find((p) => p.id === cur?.id) ?? null);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const activate = useCallback((id: string) => {
    void setActiveProject(id).catch((err) => console.error('set_active_project failed', err));
  }, []);

  const remove = useCallback((id: string) => {
    void deleteProject(id).catch((err) => console.error('delete_project failed', err));
  }, []);

  return { projects, active, activate, remove };
}

/** Live settings, kept in memory and patched through `update_settings`. */
function useSettingsData() {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let alive = true;
    void getSettings().then((loaded) => {
      if (alive) setSettings(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback((patch: SettingsPatch) => {
    void updateSettings(patch)
      .then(setSettings)
      .catch((err) => console.error('update_settings failed', err));
  }, []);

  return { settings, update };
}

/** Live autonomous-loop state, derived from `nc:loop`. The board's Auto Mode
 *  toggle and concurrency slider reflect this; the persisted concurrency is the
 *  first-load fallback until the first loop event arrives. */
function useAutoLoop(
  fallbackConcurrency: number,
  persistConcurrency: (n: number) => void,
) {
  const [loop, setLoop] = useState<LoopEnvelope | null>(null);

  useEffect(() => {
    const unlisten = onLoopEvent(setLoop);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const autoMode = loop?.state === 'running';
  const concurrency = loop?.maxConcurrency ?? fallbackConcurrency;
  const breaker = useMemo<BreakerInfo | null>(() => {
    if (loop?.state !== 'paused') return null;
    if (loop.reason === undefined || !loop.reason.toLowerCase().includes('circuit')) {
      return null;
    }
    return { failureThreshold: loop.failureThreshold };
  }, [loop]);

  const toggleAutoMode = useCallback(() => {
    const fn = loop?.state === 'running' ? stopAutoLoop : startAutoLoop;
    void fn().catch((err) => console.error('auto loop toggle failed', err));
  }, [loop]);

  const changeConcurrency = useCallback(
    (n: number) => {
      void setMaxConcurrency(n).catch((err) =>
        console.error('set_max_concurrency failed', err),
      );
      persistConcurrency(n);
    },
    [persistConcurrency],
  );

  const resume = useCallback(() => {
    void resumeAutoLoop().catch((err) => console.error('resume_auto_loop failed', err));
  }, []);

  return { autoMode, concurrency, breaker, toggleAutoMode, changeConcurrency, resume };
}

/** Git-repo status for the folder chosen in the New Project dialog. */
type GitState = 'unknown' | 'checking' | 'valid' | 'invalid';

/** The New Project flow: native folder pick → git-repo check → optional
 *  `git init` → `create_project` (which activates it). */
function useNewProjectFlow(onClose: () => void) {
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
    await gitInit(folder).catch((err) => console.error('git_init failed', err));
    setGitState('valid');
  }, [folder]);

  const create = useCallback(
    async (path: string, name: string) => {
      await createProject(path, name).catch((err) => {
        console.error('create_project failed', err);
        throw err;
      });
      reset();
      onClose();
    },
    [onClose, reset],
  );

  return { folder, gitState, pickFolder, initGit, create, reset };
}

/** The board's task + stream state, reseeded whenever a project is activated. */
function useBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [streams, setStreams] = useState<Record<string, SessionStream>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Seed from the active project's store, and reseed on every activation.
  useEffect(() => {
    let alive = true;
    const reseed = () =>
      void listTasks().then((seed) => {
        if (alive) setTasks(seed);
      });
    reseed();
    const unlisten = onProjectEvent(({ type }) => {
      if (type === 'activated' || type === 'deleted') {
        setStreams({});
        setSelectedId(null);
        reseed();
      }
    });
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = onTaskEvent((task) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === task.id);
        if (idx === -1) return [...prev, task];
        const next = prev.slice();
        next[idx] = task;
        return next;
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = onSessionEvent(({ taskId, event }) => {
      setStreams((prev) => ({
        ...prev,
        [taskId]: foldSession(prev[taskId] ?? EMPTY_STREAM, event),
      }));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return { tasks, setTasks, streams, setStreams, selectedId, setSelectedId };
}

export interface AppShellState {
  routing: ReturnType<typeof useRouting>;
  registry: ReturnType<typeof useProjectRegistry>;
  settings: ReturnType<typeof useSettingsData>;
  autoLoop: ReturnType<typeof useAutoLoop>;
  newProject: ReturnType<typeof useNewProjectFlow>;
  board: ReturnType<typeof useBoard> & {
    anyRunning: boolean;
    selected: Task | null;
    logCounts: Record<string, number>;
    handleCreate: (title: string, description: string) => Promise<void>;
    handleRun: (id: string) => void;
    handleCancel: (id: string) => void;
    handleDelete: (id: string) => void;
    handleClearColumn: (statuses: TaskStatus[]) => void;
  };
  showSplash: boolean;
  isTauri: boolean;
}

/** The shell's single composition hook: routing, the project registry, settings,
 *  the New Project flow, and the board's task/stream wiring. */
export function useAppShell(): AppShellState {
  const showSplash = useSplash();
  const routing = useRouting();
  const registry = useProjectRegistry();
  const settings = useSettingsData();
  const persistConcurrency = useCallback(
    (n: number) => settings.update({ maxConcurrency: n }),
    [settings],
  );
  const autoLoop = useAutoLoop(
    settings.settings?.maxConcurrency ?? 3,
    persistConcurrency,
  );
  const newProject = useNewProjectFlow(routing.closeNewProject);
  const board = useBoard();
  const { tasks, setTasks, streams, setStreams, selectedId, setSelectedId } = board;

  const anyRunning = useMemo(
    () => tasks.some((t) => t.status === 'in_progress'),
    [tasks],
  );
  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );
  // Streamed log-line count per task, for the running card's Logs badge.
  const logCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [id, stream] of Object.entries(streams)) {
      counts[id] = stream.tools.length;
    }
    return counts;
  }, [streams]);

  const handleCreate = useCallback(
    async (title: string, description: string) => {
      const task = await createTask(title, description);
      setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [...prev, task]));
      setSelectedId(task.id);
    },
    [setTasks, setSelectedId],
  );

  const handleRun = useCallback(
    (id: string) => {
      setStreams((prev) => ({ ...prev, [id]: { ...EMPTY_STREAM } }));
      void runTask(id).catch((err) => console.error('run_task failed', err));
    },
    [setStreams],
  );

  const handleCancel = useCallback((id: string) => {
    void cancelTask(id).catch((err) => console.error('cancel_task failed', err));
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      void deleteTask(id).catch((err) => console.error('delete_task failed', err));
      setTasks((prev) => prev.filter((t) => t.id !== id));
      setStreams((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [setTasks, setStreams, setSelectedId],
  );

  const handleClearColumn = useCallback(
    (statuses: TaskStatus[]) => {
      const targets = tasks.filter((t) => statuses.includes(t.status));
      for (const t of targets) {
        void deleteTask(t.id).catch((err) => console.error('delete_task failed', err));
      }
      const ids = new Set(targets.map((t) => t.id));
      setTasks((prev) => prev.filter((t) => !ids.has(t.id)));
      setStreams((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
      setSelectedId((cur) => (cur !== null && ids.has(cur) ? null : cur));
    },
    [tasks, setTasks, setStreams, setSelectedId],
  );

  return {
    routing,
    registry,
    settings,
    autoLoop,
    newProject,
    board: {
      ...board,
      anyRunning,
      selected,
      logCounts,
      handleCreate,
      handleRun,
      handleCancel,
      handleDelete,
      handleClearColumn,
    },
    showSplash,
    isTauri: isTauri(),
  };
}
