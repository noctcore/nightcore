import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { NightcoreEventSchema, type NightcoreEvent } from '@nightcore/contracts';

export type { SessionStatus } from '@nightcore/contracts';

/** True when running inside the Tauri webview (vs. a plain browser preview). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Invoke a Tauri command, returning `fallback` (resolved) outside the webview so
 *  Storybook/browser preview no-ops with mock data instead of rejecting. Folds the
 *  repeated `if (!isTauri()) return …` guard into one place. */
function tauriInvoke<T>(
  command: string,
  args: Record<string, unknown>,
  fallback: T,
): Promise<T> {
  if (!isTauri()) return Promise.resolve(fallback);
  return invoke<T>(command, args);
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
  /** The SDK's own session UUID, populated once the engine emits its `init`
   *  message and the core stamps it on the task. `null` until then / for tasks
   *  that never ran. Mirrors the Rust serde field. */
  sdkSessionId: string | null;
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
  /** SDK guardrail: max conversation turns before the run stops (engine
   *  `Options.maxTurns`). `null` = inherit the resolved default (Settings →
   *  config default 200). Stamped at create from the Settings "Limits" knob. */
  maxTurns: number | null;
  /** SDK guardrail: hard cost ceiling in USD (engine `Options.maxBudgetUsd`).
   *  `null` = uncapped at the task level (the config default applies). */
  maxBudgetUsd: number | null;
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
  /** The task's max-turns ceiling (SDK guardrail) — editable pre-run. `null`
   *  clears it back to inherit (note: an explicit `null` and an absent field are
   *  indistinguishable on the Rust side — both leave the value untouched). */
  maxTurns?: number | null;
  /** The task's max-budget-USD ceiling (SDK guardrail) — editable pre-run. */
  maxBudgetUsd?: number | null;
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

/** The full engine event union streamed inside the `nc:session` envelope. This is
 *  the AUTHORITATIVE contract (`@nightcore/contracts` → `NightcoreEventSchema`),
 *  not a hand-maintained subset — so the board can never silently drift from what
 *  the engine emits (e.g. the `task-updated` subagent-step event the board used to
 *  drop). The Rust core forwards each event verbatim; `onSessionEvent` /
 *  `readTranscript` validate the wire against `NightcoreEventSchema` before use. */
export type NcEvent = NightcoreEvent;
export type { NightcoreEvent } from '@nightcore/contracts';

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
  /** Per-project default max-turns ceiling (SDK guardrail). */
  maxTurns?: number;
  /** Per-project default max-budget-USD ceiling (SDK guardrail). */
  maxBudgetUsd?: number;
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
  /** SDK guardrail: the default max-turns ceiling new tasks inherit. `null` =
   *  no Settings ceiling, so the engine's config default (200) applies. */
  maxTurns: number | null;
  /** SDK guardrail: the default max-budget-USD ceiling new tasks inherit.
   *  `null` = uncapped at the Settings level. */
  maxBudgetUsd: number | null;
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
  /** The default max-turns ceiling (SDK guardrail). With a `projectId` it lands
   *  in that project's override; without one, the global default. */
  maxTurns?: number;
  /** The default max-budget-USD ceiling (SDK guardrail). */
  maxBudgetUsd?: number;
}

/** Read-only application metadata for the About page. Mirrors the Rust `AppInfo`. */
export interface AppInfo {
  version: string;
  repository: string;
}

/** `nc:project` payload: a registry change plus the full registry snapshot.
 *  `renamed` carries the updated project (name changed; active pointer unchanged). */
export interface ProjectEnvelope {
  type: 'created' | 'deleted' | 'activated' | 'renamed';
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
  return tauriInvoke<Task[]>('list_tasks', {}, []);
}

/** Optional per-task launch overrides settable at create time (M4.7 §F). All
 *  default to `null` = inherit the resolved project/global default. */
export interface CreateTaskOptions {
  permissionMode?: PermissionMode | null;
  model?: string | null;
  effort?: string | null;
  /** SDK-guardrail max-turns override (`null` = inherit the resolved Settings
   *  default → config default 200). */
  maxTurns?: number | null;
  /** SDK-guardrail max-budget-USD override (`null` = inherit). */
  maxBudgetUsd?: number | null;
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
    maxTurns: options.maxTurns ?? null,
    maxBudgetUsd: options.maxBudgetUsd ?? null,
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
  return tauriInvoke<string[]>('blocked_task_ids', {}, []);
}

/** Manually move a task to `status` (drag between columns). The backend rejects a
 *  move into `in_progress` and any unknown status. No-op outside Tauri (preview):
 *  the caller keeps its optimistic update and there is no event to reconcile. */
export async function moveTask(id: string, status: TaskStatus): Promise<void> {
  await tauriInvoke<Task | null>('move_task', { id, status }, null);
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
  const raw = await tauriInvoke<unknown>('read_transcript', { taskId }, []);
  if (!Array.isArray(raw)) return [];
  // Validate each persisted line against the authoritative event contract,
  // dropping any entry that fails (a partial write / legacy variant) rather than
  // feeding a malformed event into `foldSession`.
  const events: NcEvent[] = [];
  for (const entry of raw) {
    const parsed = NightcoreEventSchema.safeParse(entry);
    if (parsed.success) events.push(parsed.data);
  }
  return events;
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
  await tauriInvoke<void>(
    'respond_permission',
    {
      taskId,
      requestId,
      decision,
      updatedInput: options.updatedInput ?? null,
      message: options.message ?? null,
    },
    undefined,
  );
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
  return tauriInvoke<GauntletResult>('run_gauntlet', { id }, { passed: true, steps: [] });
}

// --- Worktrees (M4.6) -----------------------------------------------------

/** The active project's live worktrees (M4.6, §C) — branch, path, grouped task
 *  ids, dirty flag, and ahead-of-base count — driving the worktree switcher's
 *  tabs + monitor indicators. Read-only git status; tolerates a missing/locked
 *  worktree. Returns `[]` outside Tauri (browser preview); the switcher falls
 *  back to distinct task branches there. */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  return tauriInvoke<WorktreeInfo[]>('list_worktrees', {}, []);
}

// --- Autonomous loop (M2) -------------------------------------------------

/** Start the autonomous loop: ready tasks are leased and run up to the live
 *  concurrency. No-ops outside Tauri (browser preview). */
export async function startAutoLoop(): Promise<void> {
  await tauriInvoke<void>('start_auto_loop', {}, undefined);
}

/** Stop the autonomous loop. In-flight runs finish; no new tasks are leased. */
export async function stopAutoLoop(): Promise<void> {
  await tauriInvoke<void>('stop_auto_loop', {}, undefined);
}

/** Resume the loop after a circuit-breaker pause, clearing the failure count. */
export async function resumeAutoLoop(): Promise<void> {
  await tauriInvoke<void>('resume_auto_loop', {}, undefined);
}

/** Resize the live agent pool. The same value the Settings concurrency control
 *  writes; reading it back from `nc:loop` keeps both controls in sync. */
export async function setMaxConcurrency(n: number): Promise<void> {
  await tauriInvoke<void>('set_max_concurrency_cmd', { n }, undefined);
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
  return tauriInvoke<Project[]>('list_projects', {}, [MOCK_PROJECT]);
}

/** The active project, if any. Returns the mock outside Tauri. */
export async function activeProject(): Promise<Project | null> {
  return tauriInvoke<Project | null>('active_project', {}, MOCK_PROJECT);
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

/** Rename a project in the registry (the repo on disk is left untouched).
 *  Returns the updated project; emits `nc:project { type: "renamed" }`. */
export async function renameProject(id: string, name: string): Promise<Project> {
  return invoke<Project>('rename_project', { id, name });
}

/** Whether `path` is a git repository. `true` outside Tauri (preview). */
export async function isGitRepo(path: string): Promise<boolean> {
  return tauriInvoke<boolean>('is_git_repo', { path }, true);
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
  maxTurns: null,
  maxBudgetUsd: null,
  projectOverrides: {},
};

/** App metadata used outside Tauri (browser preview). */
const MOCK_APP_INFO: AppInfo = {
  version: '0.0.0',
  repository: 'https://github.com/Shironex/nightcore',
};

/** The current settings. Returns mock defaults outside Tauri. */
export async function getSettings(): Promise<Settings> {
  return tauriInvoke<Settings>('get_settings', {}, MOCK_SETTINGS);
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
  return tauriInvoke<AppInfo>('app_info', {}, MOCK_APP_INFO);
}

// --- Events ---------------------------------------------------------------

/** True when `value` is a non-null object exposing every key in `keys`. The
 *  shared spine of the defensive narrowers below — narrows `value` to a string
 *  record so each guard can then check the field *types* it actually reads. */
function hasKeys<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  return keys.every((k) => k in value);
}

/** Narrow an unknown payload to a `Task` defensively. Checks the fields the board
 *  reducer + optimistic-move reconciliation actually read (`id`, `status`,
 *  `createdAt`/`updatedAt` timestamps) rather than trusting the rest blindly. */
function isTask(value: unknown): value is Task {
  if (!hasKeys(value, ['id', 'status', 'createdAt', 'updatedAt'])) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

/** Parse an unknown `nc:session` payload into a validated `SessionEnvelope`, or
 *  `null` when the shape or the inner event fails the authoritative contract.
 *  The inner `event` is validated against `NightcoreEventSchema` (C3): a
 *  malformed/again-future event is dropped rather than fed to `foldSession`. */
function parseSessionEnvelope(value: unknown): SessionEnvelope | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.taskId !== 'string') return null;
  const parsed = NightcoreEventSchema.safeParse(v.event);
  if (!parsed.success) return null;
  return { taskId: v.taskId, event: parsed.data };
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
    const envelope = parseSessionEnvelope(event.payload);
    if (envelope !== null) handler(envelope);
  });
}

/** Narrow an unknown payload to a `ProjectEnvelope` defensively. The handler reads
 *  `type`, the full `projects` snapshot, and `project` (for activated/renamed), so
 *  all three are checked: a valid `type`, an array `projects`, and `project` being
 *  an object-or-null. */
function isProjectEnvelope(value: unknown): value is ProjectEnvelope {
  if (!hasKeys(value, ['type', 'project', 'projects'])) return false;
  return (
    (value.type === 'created' ||
      value.type === 'deleted' ||
      value.type === 'activated' ||
      value.type === 'renamed') &&
    Array.isArray(value.projects) &&
    (value.project === null || typeof value.project === 'object')
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

/** Narrow an unknown payload to a `LoopEnvelope` defensively. The handler reads
 *  `state`, `maxConcurrency`, `reason`, and `failureThreshold` (the breaker
 *  badge), so the numeric fields it depends on are type-checked too. */
function isLoopEnvelope(value: unknown): value is LoopEnvelope {
  if (!hasKeys(value, ['state', 'maxConcurrency', 'failureThreshold'])) return false;
  return (
    (value.state === 'running' ||
      value.state === 'drained' ||
      value.state === 'paused') &&
    typeof value.maxConcurrency === 'number' &&
    typeof value.failureThreshold === 'number'
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

/** Narrow an unknown payload to a `PermissionPrompt` defensively. The prompt UI
 *  reads `taskId`, `requestId`, `toolName`, and renders `input`, so all four are
 *  checked (`input` must be a non-null object — the surface iterates it). */
function isPermissionPrompt(value: unknown): value is PermissionPrompt {
  if (!hasKeys(value, ['taskId', 'requestId', 'toolName', 'input'])) return false;
  return (
    typeof value.taskId === 'string' &&
    typeof value.requestId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.input === 'object' &&
    value.input !== null
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
