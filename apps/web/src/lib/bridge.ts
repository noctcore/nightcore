import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

/** True when running inside the Tauri webview (vs. a plain browser preview). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Lifecycle status of a task. Mirrors the Rust `TaskStatus` enum exactly.
 *  `verifying` (M4) is the post-build reviewer phase: a reviewer session reads
 *  the worktree diff between `in_progress` and a terminal state. */
export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'verifying'
  | 'waiting_approval'
  | 'done'
  | 'failed';

/** The kind preset a task runs under (M4). Mirrors the Rust `TaskKind` enum
 *  (snake_case on the wire). `build` (default) writes code in its own worktree
 *  and is verified after; `research`/`review`/`decompose` are reserved variants
 *  the picker surfaces but the engine only fully drives `build`/`research` this
 *  milestone (`review`/`decompose` render as "coming soon"). */
export type TaskKind = 'build' | 'research' | 'review' | 'decompose';

/** Where a task's run executes (M4.6). Mirrors the Rust `RunMode` enum
 *  (snake_case on the wire). `main` (default) edits the project directory in
 *  place — no worktree, no branch, and `merge_task` refuses it (nothing to
 *  merge). `worktree` isolates the task on its own `nc/<id>` branch as before. */
export type RunMode = 'main' | 'worktree';

/** A per-task permission mode override (M4.7 §F). Mirrors the Rust UI modes:
 *  `bypass` (no prompts — the studio default), `auto-accept` (acceptEdits),
 *  `ask` (prompt on risky tools), `plan` (plan-only). `null` = inherit the
 *  resolved project/global default. Settable at create + editable pre-run. */
export type PermissionMode = 'bypass' | 'auto-accept' | 'ask' | 'plan';

/** The shared task shape. Mirrors the Rust serde struct (camelCase) exactly. */
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  model: string | null;
  /** Per-task reasoning-effort override (M4.7 §E): one of the SDK effort levels
   *  (`low`|`medium`|`high`|`none`). `null` = inherit the resolved default. */
  effort: string | null;
  /** Per-task permission-mode override (M4.7 §F). `null` = inherit the resolved
   *  project/global default (which defaults to `bypass`). */
  permissionMode: PermissionMode | null;
  /** The worktree branch (`nc/<id>`) once the coordinator allocates one; else null. */
  branch: string | null;
  createdAt: number;
  updatedAt: number;
  sessionId: number | null;
  summary: string | null;
  error: string | null;
  costUsd: number | null;
  /** Plan text captured when a `plan`-mode run hits `ExitPlanMode` and the task
   *  enters `waiting_approval`. Shown in the detail panel; null until produced. */
  plan: string | null;
  /** True once `commit_task` created a commit on the task's worktree branch. */
  committed: boolean;
  /** True once `merge_task` integrated the branch into the project base. */
  merged: boolean;
  /** True when `merge_task` hit a conflict it refused to force. */
  conflict: boolean;
  /** The kind preset this task runs under (M4). Defaults to `build`. */
  kind: TaskKind;
  /** Where this task runs (M4.6). Defaults to `main` (edits the project tree in
   *  place); `worktree` allocates an isolated `nc/<id>` branch. Settable at
   *  create + editable pre-run. Legacy tasks (no `run_mode`) load as `main`. */
  runMode: RunMode;
  /** True only after a reviewer PASS (or a user `accept_review` override). The
   *  pre-merge gate (`merge_task`) refuses while this is false. Cleared on a
   *  fresh run. */
  verified: boolean;
  /** The reviewer's full verdict text (rationale + the machine-readable
   *  `VERDICT:` line). `null` until a review runs; cleared on a fresh run. */
  review: string | null;
  /** How many bounded auto-fix attempts the verification loop has spent
   *  (`MAX_FIX_ATTEMPTS = 2`). Reset to 0 on a fresh run. */
  fixAttempts: number;
}

/** Partial update sent to `update_task`. All fields optional. */
export interface TaskPatch {
  title?: string;
  description?: string;
  status?: TaskStatus;
  dependencies?: string[];
  model?: string | null;
  /** The task's reasoning-effort override (M4.7 §E) — set from the model/effort
   *  picker. `null` clears it back to inherit. */
  effort?: string | null;
  /** The task's permission-mode override (M4.7 §F) — set from the permission-mode
   *  picker. `null` clears it back to inherit. */
  permissionMode?: PermissionMode | null;
  /** The task's kind preset (M4) — set from the create/edit picker. */
  kind?: TaskKind;
  /** The task's run mode (M4.6) — editable pre-run from the create/edit form. */
  runMode?: RunMode;
}

/** One live worktree for the active project (M4.6, §C). Mirrors the Rust
 *  `list_worktrees` result struct (camelCase). Drives the worktree switcher's
 *  tabs + per-tab monitor indicators. Read-only git status, kept cheap. */
export interface WorktreeInfo {
  /** The worktree's branch (`nc/<taskId>` in the v1 one-worktree-per-task model). */
  branch: string;
  /** Absolute path of the worktree on disk. */
  path: string;
  /** Ids of the tasks grouped under this worktree's branch. */
  taskIds: string[];
  /** Whether the worktree has uncommitted changes (drives the dirty indicator). */
  dirty: boolean;
  /** Commits ahead of the project base (drives the "ahead" indicator). */
  aheadOfBase: number;
}

/** One step of the pre-merge readiness gauntlet (M4, §C). The detector runs the
 *  project's real tooling (typecheck → lint → test), stopping at the first
 *  failure; later steps after a failure are `skipped`. */
export interface GauntletStep {
  /** The step's logical name (e.g. `typecheck`, `lint`, `test`). */
  name: string;
  /** The exact command run (e.g. `bun run test`), for the UI to surface. */
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  /** The process exit code, when the step actually ran. */
  exitCode?: number;
}

/** The structured result of a readiness-gauntlet run (M4, §C). A project with no
 *  detectable tooling passes trivially (`steps` empty). `merge_task` is gated on
 *  `passed`; the Verified column surfaces the steps on demand via `run_gauntlet`. */
export interface GauntletResult {
  passed: boolean;
  steps: GauntletStep[];
  /** The name of the first failing step, when `passed` is false. */
  failedStep?: string;
}

/** The subset of the engine's `NightcoreEvent` the board renders. The Rust core
 *  forwards each event verbatim inside the `nc:session` envelope. */
export type NcEvent =
  | {
      type: 'session-started';
      sessionId: number;
      model: string;
      permissionMode: string;
    }
  | { type: 'session-ready'; sessionId: number; sdkSessionId: string; model: string }
  | { type: 'assistant-delta'; sessionId: number; text: string; partial: boolean }
  | {
      type: 'tool-use-requested';
      sessionId: number;
      toolName: string;
      input: Record<string, unknown>;
    }
  | { type: 'tool-result'; sessionId: number; isError: boolean; content: string }
  | { type: 'permission-required'; sessionId: number; toolName: string }
  | {
      type: 'session-completed';
      sessionId: number;
      costUsd: number;
      numTurns: number;
      durationMs: number;
    }
  | { type: 'session-failed'; sessionId: number; reason: string; message: string }
  | { type: 'session-status'; sessionId: number; status: string };

/** `nc:session` payload: a streamed engine event tagged with its task. */
export interface SessionEnvelope {
  taskId: string;
  event: NcEvent;
}

/** A surface decision for a parked permission prompt. Mirrors the Rust
 *  `respond_permission` arguments. An allow may rewrite the tool input; a deny may
 *  carry a short reason returned to the model. */
export type PermissionDecision = 'allow' | 'deny';

/** `nc:permission` payload: an interactive permission prompt for a running task.
 *  The input may contain paths/commands — render it, but the core never logs it. */
export interface PermissionPrompt {
  taskId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Optional SDK-provided choices the surface can offer (rarely present). */
  suggestions?: unknown;
}

/** A known project. Mirrors the Rust `Project` serde struct (camelCase). */
export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  createdAt: string;
  lastActiveAt: string | null;
}

/** Per-project setting overrides; absent fields fall back to the global value. */
export interface SettingsOverride {
  defaultModel?: string;
  defaultEffort?: string;
  maxConcurrency?: number;
  permissionMode?: string;
  /** Per-project default run mode (`'main'` | `'worktree'`). */
  defaultRunMode?: RunMode;
}

/** Global settings + per-project overrides. Mirrors the Rust `Settings` struct.
 *  `defaultModel` holds an SDK long id (e.g. `claude-opus-4-8`). */
export interface Settings {
  defaultModel: string;
  defaultEffort: string;
  maxConcurrency: number;
  permissionMode: string;
  cleanupWorktrees: boolean;
  notifyOnComplete: boolean;
  /** The default run mode new tasks inherit (`'main'` | `'worktree'`). */
  defaultRunMode: RunMode;
  projectOverrides: Record<string, SettingsOverride>;
}

/** Partial settings update. A `projectId` targets a per-project override; absent,
 *  the patch merges into the global block. All other fields optional. */
export interface SettingsPatch {
  projectId?: string;
  defaultModel?: string;
  defaultEffort?: string;
  maxConcurrency?: number;
  permissionMode?: string;
  cleanupWorktrees?: boolean;
  notifyOnComplete?: boolean;
  defaultRunMode?: RunMode;
}

/** Read-only application metadata for the About page. Mirrors the Rust `AppInfo`. */
export interface AppInfo {
  version: string;
  repository: string;
}

/** `nc:project` payload: a registry change plus the full registry snapshot. */
export interface ProjectEnvelope {
  type: 'created' | 'deleted' | 'activated';
  project: Project | null;
  projects: Project[];
}

/** The autonomous loop's run state. Mirrors the Rust `nc:loop` payload. */
export type LoopState = 'running' | 'drained' | 'paused';

/** `nc:loop` payload: the current state of the autonomous backend loop. */
export interface LoopEnvelope {
  state: LoopState;
  /** Set when `state === 'paused'` (e.g. a circuit-breaker reason). */
  reason?: string;
  maxConcurrency: number;
  /** How many slots are currently leased to running agents. */
  leased: number;
  /** Consecutive-failure count that trips the circuit breaker. */
  failureThreshold: number;
}

// --- Commands -------------------------------------------------------------

/** Load all persisted tasks. Returns `[]` outside Tauri (browser preview). */
export async function listTasks(): Promise<Task[]> {
  if (!isTauri()) return [];
  return invoke<Task[]>('list_tasks');
}

/** Optional per-task launch overrides settable at create time (M4.7 §F). All
 *  default to `null` = inherit the resolved project/global default. */
export interface CreateTaskOptions {
  permissionMode?: PermissionMode | null;
  model?: string | null;
  effort?: string | null;
}

/** Create a new `backlog` task. The `kind` (M4) defaults to `build` and the
 *  `runMode` (M4.6) defaults to `main` so an unqualified create is byte-identical
 *  to today. The M4.7 `permissionMode`/`model`/`effort` overrides default to
 *  `null` (inherit). No-op (throws) outside Tauri. */
export async function createTask(
  title: string,
  description: string,
  kind: TaskKind = 'build',
  runMode: RunMode = 'main',
  options: CreateTaskOptions = {},
): Promise<Task> {
  return invoke<Task>('create_task', {
    title,
    description,
    kind,
    runMode,
    permissionMode: options.permissionMode ?? null,
    model: options.model ?? null,
    effort: options.effort ?? null,
  });
}

/** Apply a partial update to a task. */
export async function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  return invoke<Task>('update_task', { id, patch });
}

/** Delete a task. */
export async function deleteTask(id: string): Promise<void> {
  await invoke('delete_task', { id });
}

/** Ids of tasks blocked on an unfinished dependency (fail-closed). Drives the
 *  board's blocked badge + locked Run. Returns `[]` outside Tauri (preview). */
export async function blockedTaskIds(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>('blocked_task_ids');
}

/** Manually move a task to `status` (drag between columns). The backend rejects a
 *  move into `in_progress` and any unknown status. No-op outside Tauri (preview):
 *  the caller keeps its optimistic update and there is no event to reconcile. */
export async function moveTask(id: string, status: TaskStatus): Promise<void> {
  if (!isTauri()) return;
  await invoke<Task>('move_task', { id, status });
}

/** Run a task through the sidecar. Rejects if a task is already running. */
export async function runTask(id: string): Promise<void> {
  await invoke('run_task', { id });
}

/** Best-effort interrupt of the current run. */
export async function cancelTask(id: string): Promise<void> {
  await invoke('cancel_task', { id });
}

// --- Transcript persistence (M4.7 §C) -------------------------------------

/** Read a task's persisted session transcript (M4.7 §C) — the same `NcEvent`s
 *  that streamed over `nc:session`, appended to a per-task JSONL by the core.
 *  The web reseeds the stream view from this on task open/mount so a reload/HMR
 *  no longer blanks the transcript. Returns `[]` outside Tauri (browser preview)
 *  and tolerates a missing/empty transcript. */
export async function readTranscript(taskId: string): Promise<NcEvent[]> {
  if (!isTauri()) return [];
  return invoke<NcEvent[]>('read_transcript', { taskId });
}

// --- Interactive permissions (M3) -----------------------------------------

/** Answer a parked permission prompt (`nc:permission`). An allow may rewrite the
 *  tool input via `updatedInput`; a deny may carry a short `message` reason.
 *  No-ops outside Tauri (browser preview). */
export async function respondPermission(
  taskId: string,
  requestId: string,
  decision: PermissionDecision,
  options: { updatedInput?: Record<string, unknown>; message?: string } = {},
): Promise<void> {
  if (!isTauri()) return;
  await invoke('respond_permission', {
    taskId,
    requestId,
    decision,
    updatedInput: options.updatedInput ?? null,
    message: options.message ?? null,
  });
}

// --- Plan approval (M3) ---------------------------------------------------

/** Approve a waiting plan: the same session switches to building it. */
export async function approveTask(id: string): Promise<void> {
  await invoke('approve_task', { id });
}

/** Reject a waiting plan: the session ends and the task fails. */
export async function rejectTask(id: string): Promise<void> {
  await invoke('reject_task', { id });
}

/** Send a waiting plan back to the backlog with the plan kept for editing. */
export async function refineTask(id: string): Promise<void> {
  await invoke('refine_task', { id });
}

// --- Commit / merge (M3) --------------------------------------------------

/** Commit a verified task's worktree (git add -A + commit from its title).
 *  Rejects with "nothing to commit" when the tree is clean. */
export async function commitTask(id: string): Promise<void> {
  await invoke('commit_task', { id });
}

/** Merge a verified task's branch into the project base. Rejects (and marks the
 *  task `conflict`) on a merge conflict — never forced. The backend gates this on
 *  `verified == true` and a passing gauntlet (M4); an unverified task is refused. */
export async function mergeTask(id: string): Promise<void> {
  await invoke('merge_task', { id });
}

// --- Verification gate (M4) -----------------------------------------------

/** Accept a parked verification (CHANGES_REQUESTED budget-exhausted / FAIL /
 *  inconclusive): the user overrides the reviewer → `verified = true`, `done`.
 *  The worktree is retained for commit/merge. */
export async function acceptReview(id: string): Promise<void> {
  await invoke('accept_review', { id });
}

/** Reject a parked verification: the task drops back to the backlog (keeping
 *  `task.review` for context) rather than merging. */
export async function rejectReview(id: string): Promise<void> {
  await invoke('reject_review', { id });
}

/** Re-dispatch a reviewer session against the current worktree without a rebuild
 *  — a fresh verification pass over the existing diff. */
export async function rerunVerification(id: string): Promise<void> {
  await invoke('rerun_verification', { id });
}

/** Run the deterministic pre-merge readiness gauntlet (typecheck → lint → test,
 *  stop at first failure) over the task's worktree and return its structured
 *  result. Drives the Verified column's "Run checks" action; a project with no
 *  detectable tooling passes trivially. No-op (empty pass) outside Tauri. */
export async function runGauntlet(id: string): Promise<GauntletResult> {
  if (!isTauri()) return { passed: true, steps: [] };
  return invoke<GauntletResult>('run_gauntlet', { id });
}

// --- Worktrees (M4.6) -----------------------------------------------------

/** The active project's live worktrees (M4.6, §C) — branch, path, grouped task
 *  ids, dirty flag, and ahead-of-base count — driving the worktree switcher's
 *  tabs + monitor indicators. Read-only git status; tolerates a missing/locked
 *  worktree. Returns `[]` outside Tauri (browser preview); the switcher falls
 *  back to distinct task branches there. */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  if (!isTauri()) return [];
  return invoke<WorktreeInfo[]>('list_worktrees');
}

// --- Autonomous loop (M2) -------------------------------------------------

/** Start the autonomous loop: ready tasks are leased and run up to the live
 *  concurrency. No-ops outside Tauri (browser preview). */
export async function startAutoLoop(): Promise<void> {
  if (!isTauri()) return;
  await invoke('start_auto_loop');
}

/** Stop the autonomous loop. In-flight runs finish; no new tasks are leased. */
export async function stopAutoLoop(): Promise<void> {
  if (!isTauri()) return;
  await invoke('stop_auto_loop');
}

/** Resume the loop after a circuit-breaker pause, clearing the failure count. */
export async function resumeAutoLoop(): Promise<void> {
  if (!isTauri()) return;
  await invoke('resume_auto_loop');
}

/** Resize the live agent pool. The same value the Settings concurrency control
 *  writes; reading it back from `nc:loop` keeps both controls in sync. */
export async function setMaxConcurrency(n: number): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_max_concurrency', { n });
}

// --- Projects -------------------------------------------------------------

/** A mock project so Storybook/browser preview shows a populated switcher. */
const MOCK_PROJECT: Project = {
  id: 'mock-nightcore',
  name: 'nightcore',
  path: '~/dev/nightcore',
  branch: 'main',
  createdAt: '2026-06-21T00:00:00Z',
  lastActiveAt: '2026-06-21T00:00:00Z',
};

/** All known projects. Returns a mock outside Tauri (browser preview). */
export async function listProjects(): Promise<Project[]> {
  if (!isTauri()) return [MOCK_PROJECT];
  return invoke<Project[]>('list_projects');
}

/** The active project, if any. Returns the mock outside Tauri. */
export async function activeProject(): Promise<Project | null> {
  if (!isTauri()) return MOCK_PROJECT;
  return invoke<Project | null>('active_project');
}

/** Register + activate a project at `path`. Rejects if `path` is not a git repo. */
export async function createProject(path: string, name: string): Promise<Project> {
  return invoke<Project>('create_project', { path, name });
}

/** Remove a project from the registry (the repo on disk is left untouched). */
export async function deleteProject(id: string): Promise<void> {
  await invoke('delete_project', { id });
}

/** Activate a project: re-scopes the board to its tasks. */
export async function setActiveProject(id: string): Promise<Project> {
  return invoke<Project>('set_active_project', { id });
}

/** Whether `path` is a git repository. `true` outside Tauri (preview). */
export async function isGitRepo(path: string): Promise<boolean> {
  if (!isTauri()) return true;
  return invoke<boolean>('is_git_repo', { path });
}

/** Initialize a git repository at `path`. */
export async function gitInit(path: string): Promise<void> {
  await invoke('git_init', { path });
}

/** Open the native folder picker; returns the chosen absolute path or `null` when
 *  cancelled. No-ops (returns `null`) outside Tauri. */
export async function chooseFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}

// --- Settings -------------------------------------------------------------

/** The default settings used outside Tauri (browser preview). */
const MOCK_SETTINGS: Settings = {
  defaultModel: 'claude-opus-4-8',
  defaultEffort: 'medium',
  maxConcurrency: 3,
  permissionMode: 'auto-accept',
  cleanupWorktrees: true,
  notifyOnComplete: false,
  defaultRunMode: 'main',
  projectOverrides: {},
};

/** App metadata used outside Tauri (browser preview). */
const MOCK_APP_INFO: AppInfo = {
  version: '0.0.0',
  repository: 'https://github.com/Shironex/nightcore',
};

/** The current settings. Returns mock defaults outside Tauri. */
export async function getSettings(): Promise<Settings> {
  if (!isTauri()) return MOCK_SETTINGS;
  return invoke<Settings>('get_settings');
}

/** Shallow-merge a settings patch (global, or a per-project override when
 *  `projectId` is set). Returns the merged settings. No-ops outside Tauri. */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  if (!isTauri()) return { ...MOCK_SETTINGS, ...patch };
  return invoke<Settings>('update_settings', { patch });
}

/** Real app metadata (version + repo URL) for the About page. Returns mock values
 *  outside Tauri (browser preview). */
export async function getAppInfo(): Promise<AppInfo> {
  if (!isTauri()) return MOCK_APP_INFO;
  return invoke<AppInfo>('app_info');
}

// --- Events ---------------------------------------------------------------

/** Narrow an unknown payload to a `Task` defensively. */
function isTask(value: unknown): value is Task {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.status === 'string';
}

/** Narrow an unknown payload to a `SessionEnvelope` defensively. */
function isSessionEnvelope(value: unknown): value is SessionEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.taskId !== 'string') return false;
  const ev = v.event;
  return typeof ev === 'object' && ev !== null && 'type' in ev;
}

/** Subscribe to `nc:task` board upserts. Returns an unlisten function. */
export async function onTaskEvent(
  handler: (task: Task) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>('nc:task', (event) => {
    if (isTask(event.payload)) handler(event.payload);
  });
}

/** Subscribe to `nc:session` streamed events. Returns an unlisten function. */
export async function onSessionEvent(
  handler: (envelope: SessionEnvelope) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>('nc:session', (event) => {
    if (isSessionEnvelope(event.payload)) handler(event.payload);
  });
}

/** Narrow an unknown payload to a `ProjectEnvelope` defensively. */
function isProjectEnvelope(value: unknown): value is ProjectEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.type === 'created' || v.type === 'deleted' || v.type === 'activated') &&
    Array.isArray(v.projects)
  );
}

/** Subscribe to `nc:project` registry changes. Returns an unlisten function. */
export async function onProjectEvent(
  handler: (envelope: ProjectEnvelope) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>('nc:project', (event) => {
    if (isProjectEnvelope(event.payload)) handler(event.payload);
  });
}

/** Narrow an unknown payload to a `LoopEnvelope` defensively. */
function isLoopEnvelope(value: unknown): value is LoopEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.state === 'running' || v.state === 'drained' || v.state === 'paused') &&
    typeof v.maxConcurrency === 'number'
  );
}

/** Subscribe to `nc:loop` autonomous-loop state changes. Returns an unlisten
 *  function (a no-op outside Tauri). */
export async function onLoopEvent(
  handler: (envelope: LoopEnvelope) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>('nc:loop', (event) => {
    if (isLoopEnvelope(event.payload)) handler(event.payload);
  });
}

/** Narrow an unknown payload to a `PermissionPrompt` defensively. */
function isPermissionPrompt(value: unknown): value is PermissionPrompt {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.taskId === 'string' &&
    typeof v.requestId === 'string' &&
    typeof v.toolName === 'string'
  );
}

/** Subscribe to `nc:permission` interactive prompts. Returns an unlisten function
 *  (a no-op outside Tauri). */
export async function onPermissionEvent(
  handler: (prompt: PermissionPrompt) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<unknown>('nc:permission', (event) => {
    if (isPermissionPrompt(event.payload)) handler(event.payload);
  });
}
