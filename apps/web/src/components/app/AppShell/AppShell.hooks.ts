import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  acceptReview,
  activeProject,
  approveTask,
  blockedTaskIds,
  cancelTask,
  chooseFolder,
  commitTask,
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
  mergeTask,
  moveTask,
  refineTask,
  rejectReview,
  rejectTask,
  rerunVerification,
  runGauntlet,
  onLoopEvent,
  onPermissionEvent,
  onProjectEvent,
  onSessionEvent,
  onTaskEvent,
  resumeAutoLoop,
  respondPermission,
  runTask,
  setActiveProject,
  setMaxConcurrency,
  startAutoLoop,
  stopAutoLoop,
  updateTask,
  updateSettings,
  type GauntletResult,
  type LoopEnvelope,
  type PermissionPrompt,
  type Project,
  type Settings,
  type SettingsPatch,
  type Task,
  type TaskKind,
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

/** The backend-computed blocked-task set (deps not yet satisfied, fail-closed).
 *  Fetched on mount and refreshed on every `nc:task` — dependency satisfaction
 *  changes as tasks complete, so a card unblocks the moment its last dep lands. */
function useBlockedIds(): Set<string> {
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void blockedTaskIds().then((ids) => {
        if (alive) setBlockedIds(new Set(ids));
      });
    refresh();
    const unlisten = onTaskEvent(() => refresh());
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  return blockedIds;
}

/** Parked interactive permission prompts, grouped by task id and kept in sync with
 *  `nc:permission`. Answering removes a prompt optimistically (the backend resolves
 *  the parked request); a terminal `nc:task` for a task drops any stale prompts. */
function usePermissions(tasks: Task[]) {
  const [prompts, setPrompts] = useState<Record<string, PermissionPrompt[]>>({});

  useEffect(() => {
    const unlisten = onPermissionEvent((prompt) => {
      setPrompts((prev) => {
        const existing = prev[prompt.taskId] ?? [];
        if (existing.some((p) => p.requestId === prompt.requestId)) return prev;
        return { ...prev, [prompt.taskId]: [...existing, prompt] };
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Drop prompts for any task no longer running — a cancel/terminal transition
  // fail-closed-denies them on the backend, so they must not linger in the UI.
  useEffect(() => {
    const running = new Set(tasks.filter((t) => t.status === 'in_progress').map((t) => t.id));
    setPrompts((prev) => {
      const next: Record<string, PermissionPrompt[]> = {};
      let changed = false;
      for (const [taskId, list] of Object.entries(prev)) {
        if (running.has(taskId)) next[taskId] = list;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  const respond = useCallback(
    (taskId: string, requestId: string, decision: 'allow' | 'deny') => {
      setPrompts((prev) => {
        const list = (prev[taskId] ?? []).filter((p) => p.requestId !== requestId);
        const next = { ...prev };
        if (list.length === 0) delete next[taskId];
        else next[taskId] = list;
        return next;
      });
      void respondPermission(taskId, requestId, decision).catch((err) =>
        console.error('respond_permission failed', err),
      );
    },
    [],
  );

  return { prompts, respond };
}

/** Per-task readiness-gauntlet results + in-flight state (M4, §C). The Verified
 *  column runs the gauntlet on demand; the result gates the merge. Results are
 *  cleared whenever the project is re-activated (the board re-seeds). */
function useGauntlet() {
  const [results, setResults] = useState<Record<string, GauntletResult>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unlisten = onProjectEvent(({ type }) => {
      if (type === 'activated' || type === 'deleted') {
        setResults({});
        setRunning(new Set());
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const run = useCallback((id: string) => {
    setRunning((prev) => new Set(prev).add(id));
    void runGauntlet(id)
      .then((result) => setResults((prev) => ({ ...prev, [id]: result })))
      .catch((err) => console.error('run_gauntlet failed', err))
      .finally(() =>
        setRunning((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
      );
  }, []);

  return { results, running, run };
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
    blockedIds: Set<string>;
    /** Parked permission prompts keyed by task id (`nc:permission`). */
    prompts: Record<string, PermissionPrompt[]>;
    /** Task ids with at least one parked prompt — drives the card's pulse. */
    promptIds: Set<string>;
    /** Per-task readiness-gauntlet results (M4), keyed by task id. */
    gauntletResults: Record<string, GauntletResult>;
    /** Task ids with a gauntlet run in flight. */
    gauntletRunning: Set<string>;
    handleCreate: (title: string, description: string, kind: TaskKind) => Promise<void>;
    handleRun: (id: string) => void;
    handleCancel: (id: string) => void;
    handleDelete: (id: string) => void;
    handleClearColumn: (statuses: TaskStatus[]) => void;
    handleMoveTask: (id: string, status: TaskStatus) => void;
    handleRespondPermission: (
      taskId: string,
      requestId: string,
      decision: 'allow' | 'deny',
    ) => void;
    handleApprove: (id: string) => void;
    handleReject: (id: string) => void;
    handleRefine: (id: string) => void;
    handleCommit: (id: string) => void;
    handleMerge: (id: string) => void;
    /** Edit a not-yet-run task's kind (M4). */
    handleChangeKind: (id: string, kind: TaskKind) => void;
    /** Verification-approval actions for a review-parked task (M4). */
    handleAcceptReview: (id: string) => void;
    handleRejectReview: (id: string) => void;
    handleRerunVerification: (id: string) => void;
    /** Run the pre-merge readiness gauntlet for a verified task (M4). */
    handleRunGauntlet: (id: string) => void;
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
  const blockedIds = useBlockedIds();
  const { tasks, setTasks, streams, setStreams, selectedId, setSelectedId } = board;
  const permissions = usePermissions(tasks);
  const gauntlet = useGauntlet();

  const anyRunning = useMemo(
    () => tasks.some((t) => t.status === 'in_progress' || t.status === 'verifying'),
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
    async (title: string, description: string, kind: TaskKind) => {
      const task = await createTask(title, description, kind);
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

  // Drag-move between columns: optimistically retag the card, then call the
  // backend. The `nc:task` echo reconciles the authoritative status; on failure
  // we roll back to the previous status so the board never lies.
  const handleMoveTask = useCallback(
    (id: string, status: TaskStatus) => {
      let prevStatus: TaskStatus | undefined;
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          prevStatus = t.status;
          return { ...t, status };
        }),
      );
      void moveTask(id, status).catch((err) => {
        console.error('move_task failed', err);
        if (prevStatus === undefined) return;
        setTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: prevStatus as TaskStatus } : t)),
        );
      });
    },
    [setTasks],
  );

  // Plan-approval + commit/merge actions. Each resolves a parked request or runs a
  // git op on the backend; the authoritative status arrives via `nc:task`.
  const handleApprove = useCallback((id: string) => {
    void approveTask(id).catch((err) => console.error('approve_task failed', err));
  }, []);
  const handleReject = useCallback((id: string) => {
    void rejectTask(id).catch((err) => console.error('reject_task failed', err));
  }, []);
  const handleRefine = useCallback((id: string) => {
    void refineTask(id).catch((err) => console.error('refine_task failed', err));
  }, []);
  const handleCommit = useCallback((id: string) => {
    void commitTask(id).catch((err) => console.error('commit_task failed', err));
  }, []);
  const handleMerge = useCallback((id: string) => {
    void mergeTask(id).catch((err) => console.error('merge_task failed', err));
  }, []);

  // M4 verification-gate actions. `change_kind` patches a not-yet-run task;
  // accept/reject/rerun resolve a review-parked verification; run_gauntlet drives
  // the pre-merge readiness check. Authoritative status arrives via `nc:task`.
  const handleChangeKind = useCallback(
    (id: string, kind: TaskKind) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, kind } : t)));
      void updateTask(id, { kind }).catch((err) => console.error('update_task failed', err));
    },
    [setTasks],
  );
  const handleAcceptReview = useCallback((id: string) => {
    void acceptReview(id).catch((err) => console.error('accept_review failed', err));
  }, []);
  const handleRejectReview = useCallback((id: string) => {
    void rejectReview(id).catch((err) => console.error('reject_review failed', err));
  }, []);
  const handleRerunVerification = useCallback((id: string) => {
    void rerunVerification(id).catch((err) =>
      console.error('rerun_verification failed', err),
    );
  }, []);

  const promptIds = useMemo(
    () => new Set(Object.keys(permissions.prompts)),
    [permissions.prompts],
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
      blockedIds,
      prompts: permissions.prompts,
      promptIds,
      gauntletResults: gauntlet.results,
      gauntletRunning: gauntlet.running,
      handleCreate,
      handleRun,
      handleCancel,
      handleDelete,
      handleClearColumn,
      handleMoveTask,
      handleRespondPermission: permissions.respond,
      handleApprove,
      handleReject,
      handleRefine,
      handleCommit,
      handleMerge,
      handleChangeKind,
      handleAcceptReview,
      handleRejectReview,
      handleRerunVerification,
      handleRunGauntlet: gauntlet.run,
    },
    showSplash,
    isTauri: isTauri(),
  };
}
