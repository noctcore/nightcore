import { invoke } from '@tauri-apps/api/core';
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  NightcoreEventSchema,
  QuestionItemSchema,
  type NightcoreEvent,
  type QuestionAnswer,
  type QuestionItem,
} from '@nightcore/contracts';
import type { NewAttachmentPayload } from './attachments';

export type { SessionStatus } from '@nightcore/contracts';

// --- Generated IPC types (Rust→TS codegen) --------------------------------
//
// These types are GENERATED from the Rust serde structs by `ts-rs` (run via
// `cargo test` in `apps/desktop/src-tauri`; output under `./generated/`). They
// replace the hand-mirrored interfaces that used to live here, so a Rust field
// rename can no longer silently break the board — `cargo test` regenerates the
// bindings and the CI drift guard (`git diff` over `generated/`) fails on any
// mismatch. The runtime invoke/listen wrappers + zod re-validation below are
// UNCHANGED; only the type DECLARATIONS now come from the generated bindings.
export type { Task } from './generated/Task';
export type { TaskAttachment } from './generated/TaskAttachment';
export type { TaskPatch } from './generated/TaskPatch';
export type { TaskStatus } from './generated/TaskStatus';
export type { RunMode } from './generated/RunMode';
export type { Project } from './generated/Project';
export type { Settings } from './generated/Settings';
export type { SettingsOverride } from './generated/SettingsOverride';
export type { SettingsPatch } from './generated/SettingsPatch';
export type { McpServerEntry } from './generated/McpServerEntry';
export type { McpServerTransport } from './generated/McpServerTransport';
export type { AppInfo } from './generated/AppInfo';
export type { WorktreeInfo } from './generated/WorktreeInfo';
export type { GauntletResult } from './generated/GauntletResult';
export type { GauntletStep } from './generated/GauntletStep';
export type { StructureLockResult } from './generated/StructureLockResult';
export type { StructureLockCheck } from './generated/StructureLockCheck';
export type { LoopEnvelope } from './generated/LoopEnvelope';
export type { SessionInfo } from './generated/SessionInfo';
export type { SessionMessage } from './generated/SessionMessage';
export type { ProviderConfigSnapshot } from './generated/ProviderConfigSnapshot';
export type { ProviderConfigSection } from './generated/ProviderConfigSection';
export type { McpServerSummary } from './generated/McpServerSummary';
export type { SkillSummary } from './generated/SkillSummary';
export type { SubagentSummary } from './generated/SubagentSummary';
// Insight (codebase analysis) persisted shapes (ts-rs from `store/insight.rs`).
export type { InsightRun } from './generated/InsightRun';
export type { StoredFinding } from './generated/StoredFinding';
export type { FindingLocation } from './generated/FindingLocation';
export type { InsightUsage } from './generated/InsightUsage';
// The unified Insight taxonomy comes from the zod contract (the engine's wire
// shape); the generated `StoredFinding` keeps these as `string`, so the Insight
// view casts to these unions.
export type {
  Finding,
  FindingCategory,
  FindingSeverity,
  FindingEffort,
  AnalysisScope,
  EffortLevel,
} from '@nightcore/contracts';
// Readiness Scorecard (Profile) persisted shapes (ts-rs from `store/scorecard.rs`).
export type { ScorecardRun } from './generated/ScorecardRun';
export type { StoredReading } from './generated/StoredReading';
export type { ScorecardEvidence } from './generated/ScorecardEvidence';
// The Scorecard taxonomy comes from the zod contract (the engine's wire shape); the
// generated `StoredReading` keeps `dimension`/`grade` as `string`, so the Scorecard
// view casts to these unions.
export type {
  ScorecardDimension,
  ScorecardGrade,
  ScorecardReading,
} from '@nightcore/contracts';
// Harness (codebase convention auditor) persisted shapes (ts-rs from `store/harness.rs`).
export type { HarnessRun } from './generated/HarnessRun';
export type { StoredConventionFinding } from './generated/StoredConventionFinding';
export type { StoredProposedArtifact } from './generated/StoredProposedArtifact';
export type { StoredRepoProfile } from './generated/StoredRepoProfile';
export type { StoredRepoPackage } from './generated/StoredRepoPackage';
export type { HarnessUsage } from './generated/HarnessUsage';
// The harness convention taxonomy + proposed-artifact shapes come from the zod
// contract (the engine's wire shape); the generated `Stored*` types keep the
// enum-ish fields as `string`, so the Harness view casts to these unions.
export type {
  ConventionCategory,
  ConventionKind,
  ConventionFinding,
  RepoProfile,
  RepoPackage,
  WorkspaceTool,
  ArtifactKind,
  ArtifactWriteMode,
  ProposedArtifact,
} from '@nightcore/contracts';

/** The kind preset a task runs under (M4) and the four UI permission modes are
 *  now generated FROM the Rust enums (`TaskKind` / `PermissionMode` in
 *  `store/task.rs`) rather than re-declared, so the board's pickers can't drift
 *  from the authoritative serde mapping. The generated `TaskKind` is byte-identical
 *  to the contracts `TaskKindSchema` enum (same snake_case wire union); the
 *  generated `PermissionMode` is the studio's per-task UI vocabulary
 *  (`bypass`/`auto-accept`/`ask`/`plan`), distinct from the contracts SDK
 *  `PermissionMode` — it always lived here, never in contracts. */
export type { TaskKind } from './generated/TaskKind';
export type { PermissionMode } from './generated/PermissionMode';
/** Decompose: a proposed sub-task + its convert lifecycle, generated from the Rust
 *  `ProposedSubtask` / `SubtaskStatus` so the detail panel can't drift from serde. */
export type { ProposedSubtask } from './generated/ProposedSubtask';
export type { SubtaskStatus } from './generated/SubtaskStatus';

// Locally-aliased imports of the generated types the command wrappers below
// reference by value position (return types, fallbacks). Type-only, so they erase
// at build under `verbatimModuleSyntax`.
import type { Task } from './generated/Task';
import type { TaskPatch } from './generated/TaskPatch';
import type { TaskStatus } from './generated/TaskStatus';
import type { RunMode } from './generated/RunMode';
import type { Project } from './generated/Project';
import type { Settings } from './generated/Settings';
import type { SettingsPatch } from './generated/SettingsPatch';
import type { AppInfo } from './generated/AppInfo';
import type { WorktreeInfo } from './generated/WorktreeInfo';
import type { GauntletResult } from './generated/GauntletResult';
import type { LoopEnvelope } from './generated/LoopEnvelope';
import type { PermissionMode } from './generated/PermissionMode';
import type { TaskKind } from './generated/TaskKind';
import type { SessionInfo } from './generated/SessionInfo';
import type { SessionMessage } from './generated/SessionMessage';
import type { ProviderConfigSnapshot } from './generated/ProviderConfigSnapshot';
import type { InsightRun } from './generated/InsightRun';
import type { ScorecardRun } from './generated/ScorecardRun';
import type { HarnessRun } from './generated/HarnessRun';
import type {
  AnalysisScope,
  FindingCategory,
  EffortLevel,
  ConventionCategory,
  ScorecardDimension,
} from '@nightcore/contracts';

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

export type { QuestionItem, QuestionOption, QuestionAnswer } from '@nightcore/contracts';

/** `nc:question` payload: an interactive `AskUserQuestion` prompt for a running
 *  task. The questions/options carry model-authored text — render it, but the core
 *  never logs it. The surface answers via the `answer_question` command. */
export interface QuestionPrompt {
  taskId: string;
  requestId: string;
  /** SDK toolUseId of the originating call, when the dialog carried one. */
  toolUseId?: string;
  questions: QuestionItem[];
}

/** The `nc:project` event variant union. This is the AUTHORITATIVE type — every
 *  place that cares about project event kinds (the interface, the runtime guard,
 *  and any downstream switch) references THIS, not a hand-enumerated literal. When
 *  a new event variant is added to the Rust emitter, add it here first; the
 *  `satisfies` on `PROJECT_EVENT_TYPES` below will then force a compile error until
 *  the array is updated to match. */
export type ProjectEventType = 'created' | 'deleted' | 'activated' | 'renamed';

/** Runtime membership array for `ProjectEventType`. Must stay exhaustive: the
 *  `satisfies` clause makes adding a variant to `ProjectEventType` above without
 *  adding it here a compile error. The guard uses this array directly — no
 *  hand-enumerated strings at the call site. */
const PROJECT_EVENT_TYPES = [
  'created',
  'deleted',
  'activated',
  'renamed',
] as const satisfies readonly ProjectEventType[];

/** `nc:project` payload: a registry change plus the full registry snapshot.
 *  `renamed` carries the updated project (name changed; active pointer unchanged). */
export interface ProjectEnvelope {
  type: ProjectEventType;
  project: Project | null;
  projects: Project[];
}

/** The autonomous loop's run state. This is the AUTHORITATIVE type — the generated
 *  `LoopEnvelope.state` field is a plain `string` (Rust emits it as a free string),
 *  so this web-local union is the single source of truth for valid states. When the
 *  Rust coordinator adds a new state, add it here first; the `satisfies` on
 *  `LOOP_STATES` below will then force a compile error until the array is updated. */
export type LoopState = 'running' | 'drained' | 'paused';

/** Runtime membership array for `LoopState`. Must stay exhaustive: the `satisfies`
 *  clause makes adding a state to `LoopState` above without adding it here a compile
 *  error. The guard uses this array directly — no hand-enumerated strings at the
 *  call site. */
const LOOP_STATES = ['running', 'drained', 'paused'] as const satisfies readonly LoopState[];

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
  /** Image attachments to persist with the task (base64 payloads). Defaults to none. */
  attachments?: NewAttachmentPayload[];
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
    attachments: options.attachments ?? [],
  });
}

/** Apply a partial update to a task. */
export async function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  return invoke<Task>('update_task', { id, patch });
}

/** Delete a task (its attachment files are removed server-side). */
export async function deleteTask(id: string): Promise<void> {
  await invoke('delete_task', { id });
}

/** Persist new image attachments on an existing (pre-run) task, returning the
 *  updated task. The server enforces the per-task limit + validates each image. */
export async function addTaskAttachments(
  id: string,
  attachments: NewAttachmentPayload[],
): Promise<Task> {
  return invoke<Task>('add_task_attachments', { id, attachments });
}

/** Remove one image attachment by id, returning the updated task. */
export async function removeTaskAttachment(id: string, attachmentId: string): Promise<Task> {
  return invoke<Task>('remove_task_attachment', { id, attachmentId });
}

/** Read one attachment's bytes as base64 (no `data:` prefix) for display. Returns
 *  `''` outside Tauri (browser preview). */
export async function readTaskAttachment(id: string, attachmentId: string): Promise<string> {
  return tauriInvoke<string>('read_task_attachment', { id, attachmentId }, '');
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

// --- Session history / resume (SDK session store) -------------------------

/** List the SDK sessions discoverable for a task's project — past runs the user
 *  can view or resume, each tagged `orphaned` (its worktree was pruned) Rust-side.
 *  Lists by the project root with `includeWorktrees`, so a pruned-worktree session
 *  won't appear here (read its transcript by UUID via `getTaskSessionMessages`).
 *  Returns `[]` outside Tauri (browser preview). */
export async function listTaskSessions(taskId: string): Promise<SessionInfo[]> {
  return tauriInvoke<SessionInfo[]>('list_task_sessions', { taskId }, []);
}

/** Read a past session's transcript by its SDK session UUID. Resolves by UUID with
 *  no dir (prune-safe), so an orphaned session's transcript is still readable.
 *  Returns `[]` outside Tauri (browser preview) and tolerates a missing session. */
export async function getTaskSessionMessages(
  taskId: string,
  sdkSessionId: string,
): Promise<SessionMessage[]> {
  return tauriInvoke<SessionMessage[]>(
    'get_task_session_messages',
    { taskId, sdkSessionId },
    [],
  );
}

/** Resume a chosen historical session: points the task at the UUID and relaunches
 *  through the existing run path so the SDK reattaches with prior context. Refused
 *  for an orphaned session (its worktree is gone — resume would start fresh). */
export async function resumeSession(taskId: string, sdkSessionId: string): Promise<void> {
  await invoke('resume_session', { taskId, sdkSessionId });
}

/** Rename a past session (sets its custom title in the session's JSONL). */
export async function renameSession(sdkSessionId: string, title: string): Promise<void> {
  await tauriInvoke<void>('rename_session', { sdkSessionId, title }, undefined);
}

/** Tag a past session, or clear its tag when `tag` is `null`. */
export async function tagSession(sdkSessionId: string, tag: string | null): Promise<void> {
  await tauriInvoke<void>('tag_session', { sdkSessionId, tag }, undefined);
}

// --- Provider configuration inspector (read-only) -------------------------

/** A populated mock snapshot so the inspector renders outside Tauri (browser
 *  preview / Storybook). Exercises all three per-section tri-states so the panel's
 *  branches are visible without a live SDK probe. */
const MOCK_PROVIDER_CONFIG: ProviderConfigSnapshot = {
  providerId: 'claude',
  providerLabel: 'Claude',
  projectPath: '~/dev/nightcore',
  mcp: {
    status: 'supported',
    mcpServers: [
      {
        name: 'github',
        status: 'connected',
        scope: 'project',
        transport: 'http',
        toolCount: 14,
      },
      { name: 'filesystem', status: 'pending', scope: 'user', transport: 'stdio' },
    ],
  },
  skills: {
    status: 'supported',
    skills: [
      { name: 'add-feature', description: 'Plan and ship a new feature' },
      { name: 'fix-bug', description: 'Diagnose an integration that should work' },
    ],
  },
  subagents: {
    status: 'unavailable',
    error: 'probe timed out',
  },
  model: 'claude-opus-4-8',
  permissionMode: 'acceptEdits',
  outputStyle: 'default',
  extrasStatus: 'supported',
};

/** Read the active provider's RESOLVED configuration for a project — its MCP
 *  servers, skills, subagents, and scalar extras — for the read-only inspector.
 *  Omit `projectPath` to inspect the ACTIVE project (the board-header entry point);
 *  pass one to inspect another root. Each section degrades independently
 *  (supported / unsupported / unavailable), so the snapshot always resolves.
 *  Returns a populated mock outside Tauri (browser preview). */
export async function getProviderConfig(
  projectPath?: string,
): Promise<ProviderConfigSnapshot> {
  return tauriInvoke<ProviderConfigSnapshot>(
    'get_provider_config',
    { dir: projectPath ?? null },
    MOCK_PROVIDER_CONFIG,
  );
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

/** Answer a parked `AskUserQuestion` prompt (`nc:question`). `answer` is either
 *  the user's choices (`{behavior:'answer', answers}`) or a skip
 *  (`{behavior:'cancel'}`). No-ops outside Tauri (browser preview). */
export async function answerQuestion(
  taskId: string,
  requestId: string,
  answer: QuestionAnswer,
): Promise<void> {
  await tauriInvoke<void>(
    'answer_question',
    { taskId, requestId, answer },
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
  mcpServers: [],
  contextPackEnabled: true,
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

// --- Pre-flight Context Pack (Lock, feature #4) ----------------------------

/** The mock Constitution shown outside Tauri (browser preview). */
const MOCK_CONTEXT_PACK =
  '# Pre-flight Context Pack\n\nNightcore injects this trusted, project-controlled ' +
  'context into every agent run.\n\n## Project Constitution\n\n- Keep tests green.\n' +
  '- Folder-per-component for every UI component.';

/** Read the active project's curated context pack (`.nightcore/context.md`), or
 *  `null` when no project is active or none has been authored yet. Returns the mock
 *  outside Tauri (browser preview). */
export async function getContextPack(): Promise<string | null> {
  return tauriInvoke<string | null>('get_context_pack', {}, MOCK_CONTEXT_PACK);
}

/** Persist the active project's curated context pack. No-ops outside Tauri. */
export async function setContextPack(content: string): Promise<void> {
  await tauriInvoke<void>('set_context_pack', { content }, undefined);
}

/** Re-assemble the context pack from on-disk sources (`CLAUDE.md`/`AGENTS.md` +
 *  `.nightcore/memory/*.md`), persist it, and return the new content. Returns the
 *  mock outside Tauri (browser preview). */
export async function regenerateContextPack(): Promise<string> {
  return tauriInvoke<string>('regenerate_context_pack', {}, MOCK_CONTEXT_PACK);
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

/** Narrow an unknown payload to a `Task` defensively. INTENTIONALLY PARTIAL: only
 *  validates the fields the board reducer + optimistic-move reconciliation actually
 *  read (`id`, `status`, `createdAt`/`updatedAt`). The full shape is the generated
 *  `Task` type (`./generated/Task.ts`) — add checks here if the reducer starts
 *  consuming new fields that could be missing or mis-typed. */
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

/** `listen`, but the returned unlisten can NEVER throw or reject — every `nc:*`
 *  subscription routes through this. React `<StrictMode>` (dev) mounts effects
 *  twice (mount → unmount → mount), so a hook's fire-and-forget
 *  `void unlisten.then((fn) => fn())` cleanup can call Tauri's unlisten against an
 *  event registration whose internal `listeners[eventId]` entry is already gone —
 *  Tauri's unlisten isn't idempotent and throws
 *  `undefined is not an object (listeners[eventId].handlerId)`. That throw lands as
 *  an unhandled promise rejection, which `useGlobalErrorToast` then surfaces as a
 *  stray "Unexpected error" toast. Swallowing it here keeps teardown idempotent and
 *  silent (and a failed registration resolves to a no-op unlisten, so the cleanup
 *  promise never rejects either). */
async function safeListen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  try {
    const unlisten = await listen<T>(event, handler);
    return () => {
      try {
        unlisten();
      } catch {
        // Already torn down (StrictMode double-cleanup / rapid remount) — idempotent.
      }
    };
  } catch {
    // Registration failed (e.g. the Tauri runtime isn't ready) — nothing to undo.
    return () => {};
  }
}

/** Subscribe to `nc:task` board upserts. Returns an unlisten function. */
export async function onTaskEvent(
  handler: (task: Task) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return safeListen<unknown>('nc:task', (event) => {
    if (isTask(event.payload)) handler(event.payload);
  });
}

/** Subscribe to `nc:session` streamed events. Returns an unlisten function. */
export async function onSessionEvent(
  handler: (envelope: SessionEnvelope) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return safeListen<unknown>('nc:session', (event) => {
    const envelope = parseSessionEnvelope(event.payload);
    if (envelope !== null) handler(envelope);
  });
}

/** Narrow an unknown payload to a `ProjectEnvelope` defensively. The handler reads
 *  `type`, the full `projects` snapshot, and `project` (for activated/renamed), so
 *  all three are checked: a valid `type`, an array `projects`, and `project` being
 *  an object-or-null. `PROJECT_EVENT_TYPES` is the single source of truth for the
 *  membership check — no hand-enumerated string literals here. */
function isProjectEnvelope(value: unknown): value is ProjectEnvelope {
  if (!hasKeys(value, ['type', 'project', 'projects'])) return false;
  return (
    (PROJECT_EVENT_TYPES as readonly string[]).includes(value.type as string) &&
    Array.isArray(value.projects) &&
    (value.project === null || typeof value.project === 'object')
  );
}

/** Subscribe to `nc:project` registry changes. Returns an unlisten function. */
export async function onProjectEvent(
  handler: (envelope: ProjectEnvelope) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return safeListen<unknown>('nc:project', (event) => {
    if (isProjectEnvelope(event.payload)) handler(event.payload);
  });
}

/** Narrow an unknown payload to a `LoopEnvelope` defensively. The handler reads
 *  `state`, `maxConcurrency`, `reason`, and `failureThreshold` (the breaker
 *  badge), so the numeric fields it depends on are type-checked too. `LOOP_STATES`
 *  is the single source of truth for the membership check — no hand-enumerated
 *  string literals here. */
function isLoopEnvelope(value: unknown): value is LoopEnvelope {
  if (!hasKeys(value, ['state', 'maxConcurrency', 'failureThreshold'])) return false;
  return (
    (LOOP_STATES as readonly string[]).includes(value.state as string) &&
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
  return safeListen<unknown>('nc:loop', (event) => {
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
  return safeListen<unknown>('nc:permission', (event) => {
    if (isPermissionPrompt(event.payload)) handler(event.payload);
  });
}

/** Narrow an unknown payload to a `QuestionPrompt` defensively. The dock reads
 *  `taskId`, `requestId`, and renders `questions`, so all three are checked and the
 *  `questions` array is validated against the contract schema (it arrives over the
 *  dedicated `nc:question` channel, not the zod-validated session stream). */
function isQuestionPrompt(value: unknown): value is QuestionPrompt {
  if (!hasKeys(value, ['taskId', 'requestId', 'questions'])) return false;
  if (typeof value.taskId !== 'string' || typeof value.requestId !== 'string') {
    return false;
  }
  return QuestionItemSchema.array().nonempty().safeParse(value.questions).success;
}

/** Subscribe to `nc:question` interactive AskUserQuestion prompts. Returns an
 *  unlisten function (a no-op outside Tauri). */
export async function onQuestionEvent(
  handler: (prompt: QuestionPrompt) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return safeListen<unknown>('nc:question', (event) => {
    if (isQuestionPrompt(event.payload)) handler(event.payload);
  });
}

// --- Insight (codebase analysis) ------------------------------------------

/** The Insight analysis event family streamed over `nc:insight`, narrowed from
 *  the authoritative `NightcoreEvent` union. */
export type AnalysisEvent = Extract<
  NcEvent,
  {
    type:
      | 'analysis-started'
      | 'analysis-category-started'
      | 'analysis-category-completed'
      | 'analysis-completed'
      | 'analysis-failed';
  }
>;

/** A non-`NightcoreEvent` notice the Rust core emits on `nc:insight` when a finding
 *  is converted to a board task, so the open Insight view can update in place. */
export interface FindingConvertedEvent {
  type: 'finding-converted';
  runId: string;
  findingId: string;
  taskId: string;
}

/** Everything that arrives on the `nc:insight` channel. */
export type InsightEvent = AnalysisEvent | FindingConvertedEvent;

/** Start an Insight analysis run over the active project. Returns the `runId` the
 *  `analysis-*` events correlate by. Rejects outside Tauri (no active project). */
export async function startAnalysis(
  scope: AnalysisScope,
  categories: FindingCategory[],
  options: { model?: string | null; effort?: EffortLevel | null } = {},
): Promise<string> {
  return invoke<string>('start_analysis', {
    scope,
    categories,
    model: options.model ?? null,
    effort: options.effort ?? null,
  });
}

/** Cancel an in-flight analysis run (aborts every category pass). No-op outside Tauri. */
export async function cancelAnalysis(runId: string): Promise<void> {
  await tauriInvoke<void>('cancel_analysis', { runId }, undefined);
}

/** All analysis runs for the active project, newest first. `[]` outside Tauri. */
export async function listInsightRuns(): Promise<InsightRun[]> {
  return tauriInvoke<InsightRun[]>('list_insight_runs', {}, []);
}

/** One analysis run by id, or `null`. `null` outside Tauri. */
export async function getInsightRun(runId: string): Promise<InsightRun | null> {
  return tauriInvoke<InsightRun | null>('get_insight_run', { runId }, null);
}

/** Mark a finding dismissed (it stays dismissed across future re-runs). Returns
 *  the updated run. No-op (`null`) outside Tauri. */
export async function dismissFinding(
  runId: string,
  findingId: string,
): Promise<InsightRun | null> {
  return tauriInvoke<InsightRun | null>(
    'dismiss_finding',
    { runId, findingId },
    null,
  );
}

/** Restore a dismissed finding back to open. Returns the updated run. */
export async function restoreFinding(
  runId: string,
  findingId: string,
): Promise<InsightRun | null> {
  return tauriInvoke<InsightRun | null>(
    'restore_finding',
    { runId, findingId },
    null,
  );
}

/** Convert a finding into a board task (idempotent). Returns the created task. */
export async function convertFindingToTask(
  runId: string,
  findingId: string,
): Promise<Task> {
  return invoke<Task>('convert_finding_to_task', { runId, findingId });
}

/** Decompose: convert ONE proposed sub-task of a decompose task into a board task
 *  (idempotent). Returns the updated PARENT task (its proposal now `converted`). */
export async function convertSubtask(
  parentId: string,
  subtaskId: string,
): Promise<Task> {
  return invoke<Task>('convert_subtask', { parentId, subtaskId });
}

/** Decompose: convert EVERY still-open proposed sub-task of a decompose task.
 *  Returns the updated PARENT task. */
export async function convertAllSubtasks(parentId: string): Promise<Task> {
  return invoke<Task>('convert_all_subtasks', { parentId });
}

/** Delete an analysis run and its file. No-op outside Tauri. */
export async function deleteInsightRun(runId: string): Promise<void> {
  await tauriInvoke<void>('delete_insight_run', { runId }, undefined);
}

/** Narrow an unknown `nc:insight` payload to an `InsightEvent`. The `analysis-*`
 *  events are validated against the authoritative `NightcoreEventSchema`; the
 *  `finding-converted` notice (not a `NightcoreEvent`) is shape-checked. */
function parseInsightEvent(value: unknown): InsightEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.type === 'finding-converted') {
    if (
      typeof v.runId === 'string' &&
      typeof v.findingId === 'string' &&
      typeof v.taskId === 'string'
    ) {
      return {
        type: 'finding-converted',
        runId: v.runId,
        findingId: v.findingId,
        taskId: v.taskId,
      };
    }
    return null;
  }
  const parsed = NightcoreEventSchema.safeParse(value);
  if (parsed.success && parsed.data.type.startsWith('analysis-')) {
    return parsed.data as AnalysisEvent;
  }
  return null;
}

/** Subscribe to `nc:insight` streamed analysis events. Returns an unlisten
 *  function (a no-op outside Tauri). */
export async function onInsightEvent(
  handler: (event: InsightEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return safeListen<unknown>('nc:insight', (event) => {
    const parsed = parseInsightEvent(event.payload);
    if (parsed !== null) handler(parsed);
  });
}

// --- Readiness Scorecard (Profile) ----------------------------------------

/** The Scorecard event family streamed over `nc:scorecard`, narrowed from the
 *  authoritative `NightcoreEvent` union. */
export type ScorecardWireEvent = Extract<
  NcEvent,
  {
    type:
      | 'scorecard-started'
      | 'scorecard-dimension-started'
      | 'scorecard-dimension-completed'
      | 'scorecard-completed'
      | 'scorecard-failed';
  }
>;

/** A non-`NightcoreEvent` notice the Rust core emits on `nc:scorecard` when a reading
 *  is hardened into a board task, so the open Scorecard view can update in place. */
export interface ReadingConvertedEvent {
  type: 'reading-converted';
  runId: string;
  readingId: string;
  taskId: string;
}

/** Everything that arrives on the `nc:scorecard` channel. */
export type ScorecardEvent = ScorecardWireEvent | ReadingConvertedEvent;

/** Start a Readiness Scorecard run over the active project. Returns the `runId` the
 *  `scorecard-*` events correlate by. Rejects outside Tauri (no active project). */
export async function startScorecard(
  dimensions: ScorecardDimension[],
  options: { model?: string | null; effort?: EffortLevel | null } = {},
): Promise<string> {
  return invoke<string>('start_scorecard', {
    dimensions,
    model: options.model ?? null,
    effort: options.effort ?? null,
  });
}

/** Cancel an in-flight scorecard run (aborts every dimension pass). No-op outside Tauri. */
export async function cancelScorecard(runId: string): Promise<void> {
  await tauriInvoke<void>('cancel_scorecard', { runId }, undefined);
}

/** All scorecard runs for the active project, newest first. `[]` outside Tauri. */
export async function listScorecardRuns(): Promise<ScorecardRun[]> {
  return tauriInvoke<ScorecardRun[]>('list_scorecard_runs', {}, []);
}

/** One scorecard run by id, or `null`. `null` outside Tauri. */
export async function getScorecardRun(runId: string): Promise<ScorecardRun | null> {
  return tauriInvoke<ScorecardRun | null>('get_scorecard_run', { runId }, null);
}

/** Convert a reading into a board Build task that hardens that dimension
 *  (idempotent). Returns the created task. */
export async function convertReadingToTask(
  runId: string,
  readingId: string,
): Promise<Task> {
  return invoke<Task>('convert_reading_to_task', { runId, readingId });
}

/** Delete a scorecard run and its file. No-op outside Tauri. */
export async function deleteScorecardRun(runId: string): Promise<void> {
  await tauriInvoke<void>('delete_scorecard_run', { runId }, undefined);
}

/** Narrow an unknown `nc:scorecard` payload to a `ScorecardEvent`. The `scorecard-*`
 *  events are validated against the authoritative `NightcoreEventSchema`; the
 *  `reading-converted` notice (not a `NightcoreEvent`) is shape-checked. */
function parseScorecardEvent(value: unknown): ScorecardEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.type === 'reading-converted') {
    if (
      typeof v.runId === 'string' &&
      typeof v.readingId === 'string' &&
      typeof v.taskId === 'string'
    ) {
      return {
        type: 'reading-converted',
        runId: v.runId,
        readingId: v.readingId,
        taskId: v.taskId,
      };
    }
    return null;
  }
  const parsed = NightcoreEventSchema.safeParse(value);
  if (parsed.success && parsed.data.type.startsWith('scorecard-')) {
    return parsed.data as ScorecardWireEvent;
  }
  return null;
}

/** Subscribe to `nc:scorecard` streamed events. Returns an unlisten function (a
 *  no-op outside Tauri). */
export async function onScorecardEvent(
  handler: (event: ScorecardEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return safeListen<unknown>('nc:scorecard', (event) => {
    const parsed = parseScorecardEvent(event.payload);
    if (parsed !== null) handler(parsed);
  });
}

// --- Harness (codebase convention auditor) --------------------------------

/** The Harness scan event family streamed over `nc:harness`, narrowed from the
 *  authoritative `NightcoreEvent` union. Mirrors `AnalysisEvent`, with the two
 *  extra hops Harness adds (`harness-profile-ready`, `harness-proposals-ready`). */
export type HarnessScanEvent = Extract<
  NcEvent,
  {
    type:
      | 'harness-scan-started'
      | 'harness-profile-ready'
      | 'harness-category-started'
      | 'harness-category-completed'
      | 'harness-synthesis-started'
      | 'harness-proposals-ready'
      | 'harness-scan-completed'
      | 'harness-scan-failed';
  }
>;

/** A non-`NightcoreEvent` notice the Rust core emits on `nc:harness` when an
 *  artifact is written to disk, so the open Harness view can mark it applied in
 *  place. */
export interface ArtifactAppliedEvent {
  type: 'artifact-applied';
  runId: string;
  artifactId: string;
  /** The repo-relative path the artifact was written to. */
  path: string;
}

/** Everything that arrives on the `nc:harness` channel. */
export type HarnessEvent = HarnessScanEvent | ArtifactAppliedEvent;

/** Start a Harness scan over the active project. Returns the `runId` the
 *  `harness-*` events correlate by. Rejects outside Tauri (no active project). */
export async function startHarnessScan(
  categories: ConventionCategory[],
  options: { model?: string | null; effort?: EffortLevel | null } = {},
): Promise<string> {
  return invoke<string>('start_harness_scan', {
    categories,
    model: options.model ?? null,
    effort: options.effort ?? null,
  });
}

/** Cancel an in-flight Harness scan (aborts every lens pass). No-op outside Tauri. */
export async function cancelHarnessScan(runId: string): Promise<void> {
  await tauriInvoke<void>('cancel_harness_scan', { runId }, undefined);
}

/** All Harness runs for the active project, newest first. `[]` outside Tauri. */
export async function listHarnessRuns(): Promise<HarnessRun[]> {
  return tauriInvoke<HarnessRun[]>('list_harness_runs', {}, []);
}

/** One Harness run by id, or `null`. `null` outside Tauri. */
export async function getHarnessRun(runId: string): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>('get_harness_run', { runId }, null);
}

/** Delete a Harness run and its file. No-op outside Tauri. */
export async function deleteHarnessRun(runId: string): Promise<void> {
  await tauriInvoke<void>('delete_harness_run', { runId }, undefined);
}

/** Mark a convention finding dismissed (it stays dismissed across future
 *  re-scans). Returns the updated run. No-op (`null`) outside Tauri. */
export async function dismissHarnessFinding(
  runId: string,
  findingId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'dismiss_harness_finding',
    { runId, findingId },
    null,
  );
}

/** Restore a dismissed convention finding back to open. Returns the updated run. */
export async function restoreHarnessFinding(
  runId: string,
  findingId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'restore_harness_finding',
    { runId, findingId },
    null,
  );
}

/** Mark a proposed artifact dismissed (it stays dismissed across future
 *  re-scans). Returns the updated run. No-op (`null`) outside Tauri. */
export async function dismissHarnessArtifact(
  runId: string,
  artifactId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'dismiss_harness_artifact',
    { runId, artifactId },
    null,
  );
}

/** Restore a dismissed proposed artifact back to proposed. Returns the updated run. */
export async function restoreHarnessArtifact(
  runId: string,
  artifactId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'restore_harness_artifact',
    { runId, artifactId },
    null,
  );
}

/** Apply a proposed artifact into the project — WRITES to disk. `create` refuses
 *  to overwrite an existing file; `merge-section` updates a managed block. Returns
 *  the updated run, or rejects with the write error (surfaced inline). Rejects
 *  outside Tauri (no active project). */
export async function applyHarnessArtifact(
  runId: string,
  artifactId: string,
): Promise<HarnessRun> {
  return invoke<HarnessRun>('apply_harness_artifact', { runId, artifactId });
}

/** Narrow an unknown `nc:harness` payload to a `HarnessEvent`. The `harness-*`
 *  events are validated against the authoritative `NightcoreEventSchema`; the
 *  `artifact-applied` notice (not a `NightcoreEvent`) is shape-checked. */
function parseHarnessEvent(value: unknown): HarnessEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.type === 'artifact-applied') {
    if (
      typeof v.runId === 'string' &&
      typeof v.artifactId === 'string' &&
      typeof v.path === 'string'
    ) {
      return {
        type: 'artifact-applied',
        runId: v.runId,
        artifactId: v.artifactId,
        path: v.path,
      };
    }
    return null;
  }
  const parsed = NightcoreEventSchema.safeParse(value);
  if (parsed.success && parsed.data.type.startsWith('harness-')) {
    return parsed.data as HarnessScanEvent;
  }
  return null;
}

/** Subscribe to `nc:harness` streamed scan events. Returns an unlisten function
 *  (a no-op outside Tauri). */
export async function onHarnessEvent(
  handler: (event: HarnessEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return safeListen<unknown>('nc:harness', (event) => {
    const parsed = parseHarnessEvent(event.payload);
    if (parsed !== null) handler(parsed);
  });
}
