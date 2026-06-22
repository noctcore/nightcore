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
  listWorktrees,
  mergeTask,
  moveTask,
  readTranscript,
  refineTask,
  renameProject,
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
  type CreateTaskOptions,
  type GauntletResult,
  type LoopEnvelope,
  type PermissionMode,
  type PermissionPrompt,
  type Project,
  type RunMode,
  type Settings,
  type SettingsPatch,
  type Task,
  type TaskKind,
  type TaskPatch,
  type TaskStatus,
  type WorktreeInfo,
} from '@/lib/bridge';
import {
  EMPTY_STREAM,
  foldSession,
  type ActiveWorktree,
  type BreakerInfo,
  type SessionStream,
} from '@/components/board';
import { useToast, type ToastApi } from '@/components/ui';
import type { AppView } from './AppShell.types';

/** Subscribe to a load with a "still mounted" guard. Folds the three hand-rolled
 *  `let alive = true` mount-loads (#13) into one place; `load` runs once on mount
 *  and `onResult` only fires while mounted, so a late resolve can't set state on an
 *  unmounted component. */
function useAsyncData<T>(load: () => Promise<T>, onResult: (value: T) => void): void {
  // `load`/`onResult` are expected stable (defined at hook scope); we intentionally
  // run once on mount, mirroring the previous inline effects.
  useEffect(() => {
    let alive = true;
    void load().then((value) => {
      if (alive) onResult(value);
    });
    return () => {
      alive = false;
    };
  }, []);
}

/** Tracks in-flight task actions keyed by `${action}:${id}` so an action button
 *  can disable between click and the command settling — closing the double-fire
 *  window the audit flagged on Run/Approve/Refine/Reject/Commit/Merge. */
function useActionGuard() {
  const [pending, setPending] = useState<Set<string>>(new Set());

  const mark = useCallback((key: string, on: boolean) => {
    setPending((prev) => {
      if (on === prev.has(key)) return prev;
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  /** Run a guarded action: no-op if already in flight; clears the key when the
   *  underlying command settles (the dispatch-ack window that the double-click
   *  races). Returns immediately for callers that don't await. */
  const guard = useCallback(
    (action: string, id: string, run: () => Promise<unknown>): void => {
      const key = `${action}:${id}`;
      let already = false;
      setPending((prev) => {
        if (prev.has(key)) {
          already = true;
          return prev;
        }
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      if (already) return;
      void run().finally(() => mark(key, false));
    },
    [mark],
  );

  const isPending = useCallback(
    (action: string, id: string) => pending.has(`${action}:${id}`),
    [pending],
  );

  return { guard, isPending };
}

/** How long the boot splash stays up on first mount (ms). */
const SPLASH_DURATION_MS = 1400;

/** A brief boot splash on first mount, per the design. Skipped outside Tauri so
 *  Storybook/dev renders the shell immediately. */
function useSplash() {
  const [showSplash, setShowSplash] = useState(isTauri());
  useEffect(() => {
    if (!showSplash) return;
    const timer = setTimeout(() => setShowSplash(false), SPLASH_DURATION_MS);
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
function useProjectRegistry(toast: ToastApi) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<Project | null>(null);

  useAsyncData(
    () =>
      Promise.all([listProjects(), activeProject()]).catch((err) => {
        console.error('load projects failed', err);
        toast.error('Could not load projects', err);
        return [[], null] as [Project[], Project | null];
      }),
    ([list, current]) => {
      setProjects(list);
      setActive(current);
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

  return { projects, active, activate, remove, rename };
}

/** Live settings, kept in memory and patched through `update_settings`. */
function useSettingsData(toast: ToastApi) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useAsyncData(
    () =>
      getSettings().catch((err) => {
        console.error('get_settings failed', err);
        toast.error('Could not load settings', err);
        return null;
      }),
    (loaded) => {
      if (loaded !== null) setSettings(loaded);
    },
  );

  const update = useCallback(
    (patch: SettingsPatch) => {
      void updateSettings(patch)
        .then(setSettings)
        .catch((err) => {
          console.error('update_settings failed', err);
          // The control snaps back to the last-saved value on failure; surface it
          // so the change isn't silently lost.
          toast.error('Could not save settings', err);
        });
    },
    [toast],
  );

  return { settings, update };
}

/** Live autonomous-loop state, derived from `nc:loop`. The board's Auto Mode
 *  toggle and concurrency slider reflect this; the persisted concurrency is the
 *  first-load fallback until the first loop event arrives. */
function useAutoLoop(
  fallbackConcurrency: number,
  persistConcurrency: (n: number) => void,
  toast: ToastApi,
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
    void fn().catch((err) => {
      console.error('auto loop toggle failed', err);
      toast.error('Could not toggle Auto Mode', err);
    });
  }, [loop, toast]);

  const changeConcurrency = useCallback(
    (n: number) => {
      void setMaxConcurrency(n).catch((err) => {
        console.error('set_max_concurrency failed', err);
        toast.error('Could not change concurrency', err);
      });
      persistConcurrency(n);
    },
    [persistConcurrency, toast],
  );

  const resume = useCallback(() => {
    void resumeAutoLoop().catch((err) => {
      console.error('resume_auto_loop failed', err);
      toast.error('Could not resume the loop', err);
    });
  }, [toast]);

  return { autoMode, concurrency, breaker, toggleAutoMode, changeConcurrency, resume };
}

/** Git-repo status for the folder chosen in the New Project dialog. */
type GitState = 'unknown' | 'checking' | 'valid' | 'invalid';

/** The New Project flow: native folder pick → git-repo check → optional
 *  `git init` → `create_project` (which activates it). */
function useNewProjectFlow(onClose: () => void, toast: ToastApi) {
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

/** The board's task + stream state, reseeded whenever a project is activated. */
function useBoard(toast: ToastApi) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [streams, setStreams] = useState<Record<string, SessionStream>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Seed from the active project's store, and reseed on every activation.
  useEffect(() => {
    let alive = true;
    const reseed = () =>
      void listTasks()
        .then((seed) => {
          if (alive) setTasks(seed);
        })
        .catch((err) => {
          console.error('list_tasks failed', err);
          toast.error('Could not load tasks', err);
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
        // Reconcile by `updatedAt` (#6): a `nc:task` echo that is OLDER than the
        // record we already hold is a stale/out-of-order event (e.g. an optimistic
        // move racing a run's stream) — drop it so newer state isn't clobbered.
        const current = prev[idx];
        if (current !== undefined && task.updatedAt < current.updatedAt) return prev;
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

  // Reseed the opened task's transcript from its persisted JSONL (M4.7 §C) so a
  // reload/HMR no longer blanks it. Skips a task that already has a live stream
  // (an in-flight run's accumulating events must not be clobbered).
  useEffect(() => {
    if (selectedId === null) return;
    let alive = true;
    const id = selectedId;
    void readTranscript(id)
      .then((events) => {
        if (!alive || events.length === 0) return;
        setStreams((prev) => {
          if (prev[id] !== undefined) return prev;
          const seeded = events.reduce(foldSession, { ...EMPTY_STREAM });
          return { ...prev, [id]: seeded };
        });
      })
      .catch((err) => {
        // A missing/unreadable transcript is non-fatal — the panel just shows the
        // empty timeline — but surface it so the open task isn't silently blank.
        console.error('read_transcript failed', err);
        toast.error('Could not load this task’s transcript', err);
      });
    return () => {
      alive = false;
    };
  }, [selectedId, toast]);

  return { tasks, setTasks, streams, setStreams, selectedId, setSelectedId };
}

/** The backend-computed blocked-task set (deps not yet satisfied, fail-closed).
 *  Fetched on mount and refreshed on every `nc:task` — dependency satisfaction
 *  changes as tasks complete, so a card unblocks the moment its last dep lands. */
function useBlockedIds(): Set<string> {
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    // Monotonic request id (#7): every `nc:task` fires a refetch, so an older,
    // slower response must not clobber a newer one. We stamp each request and
    // only apply the latest.
    let seq = 0;
    let applied = 0;
    const refresh = () => {
      const id = ++seq;
      void blockedTaskIds()
        .then((ids) => {
          if (!alive || id < applied) return;
          applied = id;
          setBlockedIds(new Set(ids));
        })
        .catch((err) => console.error('blocked_task_ids failed', err));
    };
    refresh();
    const unlisten = onTaskEvent(() => refresh());
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  return blockedIds;
}

/** The active project's live worktrees (M4.6) plus the selected worktree tab.
 *  Worktrees are fetched on mount and refreshed on every `nc:task` (a run can
 *  allocate/dirty a worktree) and on project activation; the active selection
 *  resets to Main (`null`) whenever the project changes. */
function useWorktrees(): {
  worktrees: WorktreeInfo[];
  active: ActiveWorktree;
  setActive: (active: ActiveWorktree) => void;
} {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [active, setActive] = useState<ActiveWorktree>(null);

  useEffect(() => {
    let alive = true;
    // Monotonic request id (#7): like useBlockedIds, drop a stale response that
    // resolves after a newer refetch so the switcher never shows older data.
    let seq = 0;
    let applied = 0;
    const refresh = () => {
      const id = ++seq;
      void listWorktrees()
        .then((list) => {
          if (!alive || id < applied) return;
          applied = id;
          setWorktrees(list);
        })
        .catch((err) => console.error('list_worktrees failed', err));
    };
    refresh();
    const unlistenTask = onTaskEvent(() => refresh());
    const unlistenProject = onProjectEvent(({ type }) => {
      if (type === 'activated' || type === 'deleted') {
        setActive(null);
        refresh();
      }
    });
    return () => {
      alive = false;
      void unlistenTask.then((fn) => fn());
      void unlistenProject.then((fn) => fn());
    };
  }, []);

  return { worktrees, active, setActive };
}

/** Parked interactive permission prompts, grouped by task id and kept in sync with
 *  `nc:permission`. Answering removes a prompt optimistically (the backend resolves
 *  the parked request); a terminal `nc:task` for a task drops any stale prompts. */
function usePermissions(tasks: Task[], toast: ToastApi) {
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
      // Optimistically remove the prompt, capturing it so a failed response can
      // be re-inserted — otherwise the run parks forever on a prompt the UI
      // already dropped.
      let removed: PermissionPrompt | undefined;
      setPrompts((prev) => {
        const list = prev[taskId] ?? [];
        removed = list.find((p) => p.requestId === requestId);
        const remaining = list.filter((p) => p.requestId !== requestId);
        const next = { ...prev };
        if (remaining.length === 0) delete next[taskId];
        else next[taskId] = remaining;
        return next;
      });
      void respondPermission(taskId, requestId, decision).catch((err) => {
        console.error('respond_permission failed', err);
        toast.error('Could not answer the permission prompt', err);
        if (removed === undefined) return;
        const prompt = removed;
        // Re-insert (dedup-guarded) so the user can retry rather than hang the run.
        setPrompts((prev) => {
          const list = prev[taskId] ?? [];
          if (list.some((p) => p.requestId === prompt.requestId)) return prev;
          return { ...prev, [taskId]: [...list, prompt] };
        });
      });
    },
    [toast],
  );

  return { prompts, respond };
}

/** Per-task readiness-gauntlet results + in-flight state (M4, §C). The Verified
 *  column runs the gauntlet on demand; the result gates the merge. Results are
 *  cleared whenever the project is re-activated (the board re-seeds). */
function useGauntlet(toast: ToastApi) {
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

  const run = useCallback(
    (id: string) => {
      setRunning((prev) => new Set(prev).add(id));
      void runGauntlet(id)
        .then((result) => setResults((prev) => ({ ...prev, [id]: result })))
        .catch((err) => {
          console.error('run_gauntlet failed', err);
          toast.error('Could not run the readiness checks', err);
          // Surface a failed result so the merge gate stays closed and the user
          // sees the failure in the Verified column rather than a silent no-op.
          setResults((prev) => ({
            ...prev,
            [id]: {
              passed: false,
              steps: [],
              failedStep: 'Checks could not run',
            },
          }));
        })
        .finally(() =>
          setRunning((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          }),
        );
    },
    [toast],
  );

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
    /** The active project's live worktrees (M4.6) for the switcher. */
    worktrees: WorktreeInfo[];
    /** The selected worktree tab (`null` = Main); filters the board. */
    activeWorktree: ActiveWorktree;
    /** Select a worktree tab (sets the active worktree + filters the board). */
    setActiveWorktree: (active: ActiveWorktree) => void;
    handleCreate: (
      title: string,
      description: string,
      kind: TaskKind,
      runMode: RunMode,
      options?: CreateTaskOptions,
    ) => Promise<void>;
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
    /** Edit a not-yet-run task's run mode (M4.6). */
    handleChangeRunMode: (id: string, runMode: RunMode) => void;
    /** Edit a not-yet-run task's permission-mode override (M4.7). */
    handleChangePermissionMode: (id: string, permissionMode: PermissionMode | null) => void;
    /** Edit a not-yet-run task's model override (M4.7). */
    handleChangeModel: (id: string, model: string | null) => void;
    /** Edit a not-yet-run task's reasoning-effort override (M4.7). */
    handleChangeEffort: (id: string, effort: string | null) => void;
    /** Edit a not-yet-run task's max-turns ceiling (SDK guardrail). */
    handleChangeMaxTurns: (id: string, maxTurns: number | null) => void;
    /** Edit a not-yet-run task's max-budget-USD ceiling (SDK guardrail). */
    handleChangeMaxBudget: (id: string, maxBudgetUsd: number | null) => void;
    /** Verification-approval actions for a review-parked task (M4). */
    handleAcceptReview: (id: string) => void;
    handleRejectReview: (id: string) => void;
    handleRerunVerification: (id: string) => void;
    /** Run the pre-merge readiness gauntlet for a verified task (M4). */
    handleRunGauntlet: (id: string) => void;
    /** True while a guarded task action (`run`/`approve`/`commit`/…) is in flight,
     *  so the matching button can disable itself and not double-fire. */
    isActionPending: (action: string, id: string) => boolean;
  };
  showSplash: boolean;
  isTauri: boolean;
}

/** The shell's single composition hook: routing, the project registry, settings,
 *  the New Project flow, and the board's task/stream wiring. */
export function useAppShell(): AppShellState {
  const toast = useToast();
  const action = useActionGuard();
  const showSplash = useSplash();
  const routing = useRouting();
  const registry = useProjectRegistry(toast);
  const settings = useSettingsData(toast);
  const persistConcurrency = useCallback(
    (n: number) => settings.update({ maxConcurrency: n }),
    [settings],
  );
  const autoLoop = useAutoLoop(
    settings.settings?.maxConcurrency ?? 3,
    persistConcurrency,
    toast,
  );
  const newProject = useNewProjectFlow(routing.closeNewProject, toast);
  const board = useBoard(toast);
  const blockedIds = useBlockedIds();
  const { tasks, setTasks, streams, setStreams, selectedId, setSelectedId } = board;
  const permissions = usePermissions(tasks, toast);
  const gauntlet = useGauntlet(toast);
  const worktrees = useWorktrees();

  const anyRunning = useMemo(
    () => tasks.some((t) => t.status === 'in_progress' || t.status === 'verifying'),
    [tasks],
  );
  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );
  // Streamed log-line count per task, for the running card's Logs badge. Reads the
  // incrementally-maintained `toolCount` (perf #6) rather than re-filtering every
  // task's entries on each delta.
  const logCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [id, stream] of Object.entries(streams)) {
      counts[id] = stream.toolCount;
    }
    return counts;
  }, [streams]);

  const handleCreate = useCallback(
    async (
      title: string,
      description: string,
      kind: TaskKind,
      runMode: RunMode,
      options: CreateTaskOptions = {},
    ) => {
      try {
        const task = await createTask(title, description, kind, runMode, options);
        setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [...prev, task]));
        setSelectedId(task.id);
      } catch (err) {
        console.error('create_task failed', err);
        toast.error('Could not create task', err);
        // Rethrow so the dialog stays open for a retry (see NewTaskForm).
        throw err;
      }
    },
    [setTasks, setSelectedId, toast],
  );

  const handleRun = useCallback(
    (id: string) => {
      // Optimistically reset the stream; guard against a double-fire between the
      // click and the run being accepted.
      action.guard('run', id, () => {
        setStreams((prev) => ({ ...prev, [id]: { ...EMPTY_STREAM } }));
        return runTask(id).catch((err) => {
          console.error('run_task failed', err);
          toast.error('Could not start the run', err);
        });
      });
    },
    [action, setStreams, toast],
  );

  const handleCancel = useCallback(
    (id: string) => {
      void cancelTask(id).catch((err) => {
        console.error('cancel_task failed', err);
        toast.error('Could not cancel the run', err);
      });
    },
    [toast],
  );

  const handleDelete = useCallback(
    (id: string) => {
      void deleteTask(id).catch((err) => {
        console.error('delete_task failed', err);
        toast.error('Could not delete task', err);
      });
      setTasks((prev) => prev.filter((t) => t.id !== id));
      setStreams((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [setTasks, setStreams, setSelectedId, toast],
  );

  const handleClearColumn = useCallback(
    (statuses: TaskStatus[]) => {
      const targets = tasks.filter((t) => statuses.includes(t.status));
      for (const t of targets) {
        void deleteTask(t.id).catch((err) => {
          console.error('delete_task failed', err);
          toast.error('Could not delete task', err);
        });
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
    [tasks, setTasks, setStreams, setSelectedId, toast],
  );

  // Drag-move between columns: optimistically retag the card, then call the
  // backend. The `nc:task` echo reconciles the authoritative status; on failure
  // we roll back to the previous status so the board never lies. We skip the
  // optimistic retag for an in-flight task (#6) — a concurrent run's `nc:task`
  // stream owns its status and the move would race it; let the backend decide.
  const handleMoveTask = useCallback(
    (id: string, status: TaskStatus) => {
      let prevStatus: TaskStatus | undefined;
      let inFlight = false;
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          if (t.status === 'in_progress' || t.status === 'verifying') {
            inFlight = true;
            return t;
          }
          prevStatus = t.status;
          return { ...t, status };
        }),
      );
      void moveTask(id, status).catch((err) => {
        console.error('move_task failed', err);
        toast.error('Could not move task', err);
        if (inFlight || prevStatus === undefined) return;
        setTasks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: prevStatus as TaskStatus } : t)),
        );
      });
    },
    [setTasks, toast],
  );

  // Plan-approval + commit/merge actions. Each resolves a parked request or runs a
  // git op on the backend; the authoritative status arrives via `nc:task`. All are
  // guarded against a double-fire between click and the command settling, and
  // surface failures through the toast channel.
  const handleApprove = useCallback(
    (id: string) =>
      action.guard('approve', id, () =>
        approveTask(id).catch((err) => {
          console.error('approve_task failed', err);
          toast.error('Could not approve the plan', err);
        }),
      ),
    [action, toast],
  );
  const handleReject = useCallback(
    (id: string) =>
      action.guard('reject', id, () =>
        rejectTask(id).catch((err) => {
          console.error('reject_task failed', err);
          toast.error('Could not reject the plan', err);
        }),
      ),
    [action, toast],
  );
  const handleRefine = useCallback(
    (id: string) =>
      action.guard('refine', id, () =>
        refineTask(id).catch((err) => {
          console.error('refine_task failed', err);
          toast.error('Could not refine the plan', err);
        }),
      ),
    [action, toast],
  );
  const handleCommit = useCallback(
    (id: string) =>
      action.guard('commit', id, () =>
        commitTask(id).catch((err) => {
          console.error('commit_task failed', err);
          toast.error('Could not commit the worktree', err);
        }),
      ),
    [action, toast],
  );
  const handleMerge = useCallback(
    (id: string) =>
      action.guard('merge', id, () =>
        mergeTask(id).catch((err) => {
          console.error('merge_task failed', err);
          toast.error('Could not merge the branch', err);
        }),
      ),
    [action, toast],
  );

  // M4 not-yet-run field edits collapse into one factory (#4): each optimistically
  // patches the field, persists via `update_task`, and ROLLS BACK to the prior
  // value on failure (mirroring handleMoveTask) so a rejected edit can't leave the
  // board lying. `makeFieldUpdater<K>` keeps the seven edits byte-identical.
  const makeFieldUpdater = useCallback(
    <K extends keyof Task & keyof TaskPatch>(field: K) =>
      (id: string, value: Task[K]) => {
        let prevValue: Task[K] | undefined;
        let found = false;
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== id) return t;
            prevValue = t[field];
            found = true;
            return { ...t, [field]: value };
          }),
        );
        void updateTask(id, { [field]: value } as TaskPatch).catch((err) => {
          console.error('update_task failed', err);
          toast.error('Could not update task', err);
          if (!found) return;
          setTasks((prev) =>
            prev.map((t) => (t.id === id ? { ...t, [field]: prevValue as Task[K] } : t)),
          );
        });
      },
    [setTasks, toast],
  );

  const handleChangeKind = useMemo(() => makeFieldUpdater('kind'), [makeFieldUpdater]);
  const handleChangeRunMode = useMemo(() => makeFieldUpdater('runMode'), [makeFieldUpdater]);
  const handleChangePermissionMode = useMemo(
    () => makeFieldUpdater('permissionMode'),
    [makeFieldUpdater],
  );
  const handleChangeModel = useMemo(() => makeFieldUpdater('model'), [makeFieldUpdater]);
  const handleChangeEffort = useMemo(() => makeFieldUpdater('effort'), [makeFieldUpdater]);
  const handleChangeMaxTurns = useMemo(() => makeFieldUpdater('maxTurns'), [makeFieldUpdater]);
  const handleChangeMaxBudget = useMemo(
    () => makeFieldUpdater('maxBudgetUsd'),
    [makeFieldUpdater],
  );

  const handleAcceptReview = useCallback(
    (id: string) =>
      action.guard('acceptReview', id, () =>
        acceptReview(id).catch((err) => {
          console.error('accept_review failed', err);
          toast.error('Could not accept the review', err);
        }),
      ),
    [action, toast],
  );
  const handleRejectReview = useCallback(
    (id: string) =>
      action.guard('rejectReview', id, () =>
        rejectReview(id).catch((err) => {
          console.error('reject_review failed', err);
          toast.error('Could not reject the review', err);
        }),
      ),
    [action, toast],
  );
  const handleRerunVerification = useCallback(
    (id: string) =>
      action.guard('rerunVerification', id, () =>
        rerunVerification(id).catch((err) => {
          console.error('rerun_verification failed', err);
          toast.error('Could not rerun verification', err);
        }),
      ),
    [action, toast],
  );

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
      worktrees: worktrees.worktrees,
      activeWorktree: worktrees.active,
      setActiveWorktree: worktrees.setActive,
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
      handleChangeRunMode,
      handleChangePermissionMode,
      handleChangeModel,
      handleChangeEffort,
      handleChangeMaxTurns,
      handleChangeMaxBudget,
      handleAcceptReview,
      handleRejectReview,
      handleRerunVerification,
      handleRunGauntlet: gauntlet.run,
      isActionPending: action.isPending,
    },
    showSplash,
    isTauri: isTauri(),
  };
}
