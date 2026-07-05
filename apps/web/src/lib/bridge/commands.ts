/**
 * The web↔Rust bridge's COMMAND surface: a typed wrapper over every Tauri `invoke`
 * command the board issues, plus the argument shapes those commands accept. Each
 * wrapper either uses raw `invoke` (rejecting outside Tauri) or `tauriInvoke` (which
 * degrades to a browser-preview mock from `./mocks`). Event subscriptions live in
 * `./events`; shared types in `./types`.
 */
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

import { NightcoreEventSchema } from '@nightcore/contracts';

import type { ImageFormat, NewAttachmentPayload } from '../attachments';
import { imageDataUrl } from '../attachments';
import { isTauri, tauriInvoke } from './internal';
import {
  MOCK_APP_INFO,
  MOCK_BACKGROUNDS,
  MOCK_CONTEXT_PACK,
  MOCK_INJECTION_FLAGS,
  MOCK_POLICY_FILE,
  MOCK_PROJECT,
  MOCK_PROVIDER_CONFIG,
  MOCK_SETTINGS,
  mockSettingsWithBackground,
} from './mocks';
import type {
  AnalysisScope,
  AppInfo,
  BranchInfo,
  ConventionCategory,
  EffortLevel,
  FindingCategory,
  GauntletResult,
  HarnessPolicyFile,
  HarnessPolicyPatch,
  HarnessRun,
  InjectionFlag,
  InsightRun,
  MergePreview,
  NcEvent,
  PermissionMode,
  PrChangedFile,
  PrCommentTriage,
  PrDraft,
  PrFixState,
  Project,
  ProviderConfigSnapshot,
  PrReviewComments,
  PrReviewRun,
  PrStatus,
  PrSummary,
  PrSupport,
  QuestionAnswer,
  ReviewLens,
  RunMode,
  ScorecardDimension,
  ScorecardRun,
  SessionInfo,
  SessionMessage,
  Settings,
  SettingsPatch,
  Task,
  TaskKind,
  TaskPatch,
  TaskStatus,
  WorktreeDiff,
  WorktreeInfo,
} from './types';

// --- Commands -------------------------------------------------------------

/** Load all persisted tasks. Returns `[]` outside Tauri (browser preview). */
export async function listTasks(): Promise<Task[]> {
  return tauriInvoke<Task[]>('list_tasks', {}, []);
}

/** Optional per-task launch overrides settable at create time. All
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
  /** Worktree branch name chosen in the branch picker (worktree mode). `null` ⇒
   *  the coordinator names it `nc/<taskId>`. Ignored for main-mode tasks. */
  branch?: string | null;
  /** Base branch the worktree branches off / merges into (worktree mode). `null` ⇒
   *  the project's current branch. Ignored for main-mode tasks. */
  baseBranch?: string | null;
  /** Image attachments to persist with the task (base64 payloads). Defaults to none. */
  attachments?: NewAttachmentPayload[];
}

/** Create a new `backlog` task. The `kind` defaults to `build` and the `runMode`
 *  defaults to `main`. The `permissionMode`/`model`/`effort` overrides default to
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
    branch: options.branch ?? null,
    baseBranch: options.baseBranch ?? null,
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

// --- Transcript persistence -----------------------------------------------

/** Read a task's persisted session transcript — the same `NcEvent`s
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

// --- Interactive permissions ----------------------------------------------

/** A surface decision for a parked permission prompt. Mirrors the Rust
 *  `respond_permission` arguments. An allow may rewrite the tool input; a deny may
 *  carry a short reason returned to the model. */
export type PermissionDecision = 'allow' | 'deny';

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

// --- Plan approval --------------------------------------------------------

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

// --- Commit / merge -------------------------------------------------------

/** Commit a verified task's worktree (git add -A + commit from its title).
 *  Rejects with "nothing to commit" when the tree is clean. */
export async function commitTask(id: string): Promise<void> {
  await invoke('commit_task', { id });
}

/** Merge a verified task's branch into the project base. Rejects (and marks the
 *  task `conflict`) on a merge conflict — never forced. The backend gates this on
 *  `verified == true` and a passing gauntlet; an unverified task is refused. */
export async function mergeTask(id: string): Promise<void> {
  await invoke('merge_task', { id });
}

// --- Pull requests ----------------------------------------------------------

/** Options for {@link createPrTask}. `base` omitted ⇒ the backend resolves the
 *  task's base branch exactly like merge does. */
export interface CreatePrOptions {
  base?: string;
  title: string;
  body: string;
  draft: boolean;
}

/** Probe PR support for a task's project: `gh` on PATH + an `origin` remote.
 *  Booleans only — the raw remote URL may embed credentials and never crosses
 *  the IPC boundary. Returns a red probe outside Tauri (browser preview) so the
 *  button hides. */
export async function prSupport(id: string): Promise<PrSupport> {
  return tauriInvoke<PrSupport>('pr_support', { id }, { ghInstalled: false, hasRemote: false });
}

/** Draft a PR title/body for a task via a one-shot `claude -p` pass. The command
 *  itself degrades to a deterministic fallback (task title + description), so a
 *  resolved value is always usable; outside Tauri an empty draft is returned and
 *  the dialog falls back locally. `base` re-drafts against a picker-chosen base
 *  (the draft describes `diff <base>...HEAD`); omitted ⇒ the backend default. */
export async function draftPrMessage(id: string, base?: string): Promise<PrDraft> {
  return tauriInvoke<PrDraft>(
    'draft_pr_message',
    { id, base: base ?? null },
    { title: '', body: '' },
  );
}

/** Push a task's worktree branch to `origin` and open a pull request against
 *  `base` via the user's `gh` CLI. The backend re-runs the merge-grade gauntlet
 *  first; on success it persists `prUrl`/`prNumber` and emits the task echo.
 *  Rejects loudly (no silent fallback) so the dialog can surface the failure. */
export async function createPrTask(id: string, opts: CreatePrOptions): Promise<void> {
  const { base, title, body, draft } = opts;
  await invoke('create_pr_task', { id, base: base ?? null, title, body, draft });
}

/** Open an `https://` URL in the system browser (backend-validated https-only).
 *  Used by the PR chip; rejects on a non-https URL. */
export async function openExternal(url: string): Promise<void> {
  await invoke('open_external', { url });
}

/** Fetch the live PR status for a task (requires `prNumber` set) via a bounded
 *  `gh pr view`. On-demand only — the card fetches on mount + manual refresh;
 *  there is deliberately NO polling. Read-only (no lease). Resolves `null`
 *  outside Tauri (browser preview) so the card shows its unavailable note
 *  instead of a fabricated status. */
export async function prStatus(id: string): Promise<PrStatus | null> {
  return tauriInvoke<PrStatus | null>('pr_status', { id }, null);
}

/** Fetch the live status of an arbitrary PR by NUMBER (no task linkage — the
 *  per-PR workspace surface). Mirrors {@link prStatus}: a bounded `gh pr view`,
 *  on-demand only (fetch on mount + manual refresh; NO polling), read-only (no
 *  lease). Resolves `null` outside Tauri (browser preview) so the surface shows
 *  its unavailable note instead of a fabricated status. */
export async function prStatusByNumber(number: number): Promise<PrStatus | null> {
  return tauriInvoke<PrStatus | null>('pr_status_by_number', { number }, null);
}

/** The GitHub login the user's `gh` CLI is authenticated as, for "your PRs"
 *  filtering in the PR workspace. Read-only, on-demand. Resolves `null` outside
 *  Tauri (browser preview) — the surface skips viewer-scoped affordances. */
export async function viewerLogin(): Promise<string | null> {
  return tauriInvoke<string | null>('viewer_login', {}, null);
}

/** Re-push the task branch to its remote (plain push — never `--force`) so an
 *  open PR picks up new local commits. Void: the caller refetches `prStatus`
 *  afterwards. Rejects loudly (and outside Tauri) — no silent fallback. */
export async function pushPrUpdates(id: string): Promise<void> {
  await invoke('push_pr_updates', { id });
}

/** Finalize a REMOTE-merged PR: the backend re-verifies `state == MERGED`
 *  itself, marks the task merged locally, and honors the `cleanupWorktrees`
 *  setting. The updated task arrives via the `nc:task` echo. */
export async function finalizeMergedPr(id: string): Promise<void> {
  await invoke('finalize_merged_pr', { id });
}

/** Fast-forward-only pull of the task's base branch on the PROJECT ROOT after
 *  a remote merge. The backend refuses a dirty root or a non-ff pull — the
 *  rejection message surfaces verbatim in the failure toast. */
export async function pullBaseFf(id: string): Promise<void> {
  await invoke('pull_base_ff', { id });
}

/** Fetch the UNRESOLVED review threads + top-level review summaries for a task's
 *  PR via a bounded `gh api graphql`. Read-only, on-demand (mount + manual
 *  refresh; NO polling). Resolves an empty payload outside Tauri (browser
 *  preview) so the section shows its empty/unavailable note. */
export async function listPrComments(id: string): Promise<PrReviewComments> {
  return tauriInvoke<PrReviewComments>('list_pr_comments', { id }, { threads: [], reviews: [] });
}

/** RE-FETCH the PR review comments server-side, build a fenced fix prompt, and
 *  dispatch a fix run on the task's existing worktree — the fixes flow into the
 *  normal verify → gauntlet path, then the phase-2 Push updates button publishes
 *  them. Rejects loudly (and outside Tauri) — no silent fallback. */
export async function addressPrComments(id: string): Promise<void> {
  await invoke('address_pr_comments', { id });
}

/** RE-FETCH the PR review threads server-side and AI-triage each into
 *  actionable / false_positive / already_addressed / question (aligned to the
 *  thread order by `index`). Read-only + fail-open: the backend classifies a
 *  failed pass as all-actionable, and this resolves an empty array outside Tauri
 *  (browser preview) so the chips simply stay hidden. */
export async function triagePrComments(id: string): Promise<PrCommentTriage[]> {
  return tauriInvoke<PrCommentTriage[]>('triage_pr_comments', { id }, []);
}

// --- Verification gate ----------------------------------------------------

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

// --- Worktrees ------------------------------------------------------------

/** The active project's live worktrees — branch, path, grouped task
 *  ids, dirty flag, and ahead-of-base count — driving the worktree switcher's
 *  tabs + monitor indicators. Read-only git status; tolerates a missing/locked
 *  worktree. Returns `[]` outside Tauri (browser preview); the switcher falls
 *  back to distinct task branches there. */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  return tauriInvoke<WorktreeInfo[]>('list_worktrees', {}, []);
}

/** The active project's branches (local + remote-tracking) for the branch picker:
 *  name, remote flag, current flag, upstream, ahead/behind. Returns `[]` outside
 *  Tauri (browser preview) so the picker degrades to free-form entry. */
export async function listBranches(): Promise<BranchInfo[]> {
  return tauriInvoke<BranchInfo[]>('list_branches', {}, []);
}

/** Read-only preview of merging a task's worktree branch into `base` (defaults to
 *  the project base): ready / conflicts / diverged / up-to-date, the conflicting
 *  files, changed-file stats, and ahead/behind. Never touches the working tree.
 *  Returns an empty up-to-date preview outside Tauri. */
export async function mergePreview(id: string, base?: string): Promise<MergePreview> {
  return tauriInvoke<MergePreview>(
    'merge_preview',
    { id, base },
    {
      status: 'upToDate',
      branch: '',
      base: base ?? '',
      conflictFiles: [],
      files: [],
      additions: 0,
      deletions: 0,
      ahead: 0,
      behind: 0,
    },
  );
}

/** The changed files in a task's worktree vs base — committed + uncommitted +
 *  untracked — for the diff view. Returns an empty diff outside Tauri. */
export async function worktreeDiff(id: string): Promise<WorktreeDiff> {
  return tauriInvoke<WorktreeDiff>('worktree_diff', { id }, {
    files: [],
    summary: 'No changes',
    additions: 0,
    deletions: 0,
  });
}

/** Discard a task's worktree and its branch (safe cleanup, distinct from deleting
 *  the task). Rejects on a real failure (e.g. the task is still running) so the
 *  caller can surface it; uses raw `invoke` (no silent fallback). */
export async function discardWorktree(id: string): Promise<void> {
  await invoke('discard_worktree', { id });
}

// --- Autonomous loop ------------------------------------------------------

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

// --- Custom Board Background ------------------------------------------------

/** Persist a project's custom board-background image (bytes to app-data, ref to the
 *  project's settings override); returns the merged settings. In browser preview it
 *  caches the image in memory so `readBoardBackground` can echo it back. */
export async function setBoardBackground(
  projectId: string,
  image: { format: ImageFormat; data: string },
): Promise<Settings> {
  if (!isTauri()) {
    const version = (MOCK_BACKGROUNDS.get(projectId)?.version ?? 0) + 1;
    MOCK_BACKGROUNDS.set(projectId, { version, url: imageDataUrl(image.format, image.data) });
    return mockSettingsWithBackground(projectId, { format: image.format, version });
  }
  return invoke<Settings>('set_board_background', {
    projectId,
    format: image.format,
    data: image.data,
  });
}

/** Clear a project's custom board background (ref + on-disk bytes); returns the
 *  merged settings. Idempotent. */
export async function clearBoardBackground(projectId: string): Promise<Settings> {
  if (!isTauri()) {
    MOCK_BACKGROUNDS.delete(projectId);
    return mockSettingsWithBackground(projectId, null);
  }
  return invoke<Settings>('clear_board_background', { projectId });
}

/** Read a project's custom board background as a `data:` URL for the board's CSS
 *  `background-image`, or `null` when none is set. */
export async function readBoardBackground(projectId: string): Promise<string | null> {
  if (!isTauri()) return MOCK_BACKGROUNDS.get(projectId)?.url ?? null;
  return invoke<string | null>('read_board_background', { projectId });
}

// --- Pre-flight Context Pack ----------------------------------------------

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

// --- Insight (codebase analysis) ------------------------------------------

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

// --- PR Review (fourth scan sibling) --------------------------------------

/** One inline review comment posted alongside a GitHub review: a diff anchor
 *  (`path` + 1-based `line`) plus the Nightcore-composed body. */
export interface ReviewInlineComment {
  path: string;
  line: number;
  body: string;
}

/** The three GitHub review verdicts in the web's kebab wire form (the Rust core
 *  maps them to gh's `APPROVE` / `REQUEST_CHANGES` / `COMMENT`). */
export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';

/** Start a PR Review run over the active project's pull request `prNumber`. Returns
 *  the `runId` the `pr-review-*` events correlate by. The project path is resolved
 *  server-side from the active project (never passed). Rejects outside Tauri. */
export async function startPrReview(
  prNumber: number,
  lenses: ReviewLens[],
  options: { model?: string | null; effort?: EffortLevel | null } = {},
): Promise<string> {
  return invoke<string>('start_pr_review', {
    prNumber,
    lenses,
    model: options.model ?? null,
    effort: options.effort ?? null,
  });
}

/** Cancel an in-flight PR Review run (aborts every lens pass). No-op outside Tauri. */
export async function cancelPrReview(runId: string): Promise<void> {
  await tauriInvoke<void>('cancel_pr_review', { runId }, undefined);
}

/** The active project's OPEN pull requests (newest first, capped), for the PR
 *  Review config picker. `limit` is OPTIONAL — omitted lets the backend apply its
 *  default (50) and clamps to `1..=200`, so "load more" refetches at a doubled cap
 *  without an unbounded fetch. `[]` outside Tauri. Rejects (throws) on a gh failure
 *  so the picker can surface "not a repo / gh not installed / auth" inline. */
export async function listOpenPrs(limit?: number): Promise<PrSummary[]> {
  if (!isTauri()) return [];
  return invoke<PrSummary[]>('list_open_prs', { limit: limit ?? null });
}

/** A pull request's changed files (path + per-file line deltas) for the PR Review
 *  workspace's changed-file expander. Read-only `gh pr view --json files`, bounded
 *  + capped Rust-side; on-demand only (fetched when the expander first opens; NO
 *  polling). Every `path` is gh pass-through (untrusted contributor content) the
 *  web renders as inert text. Resolves `[]` outside Tauri (browser preview) so the
 *  expander shows its empty note instead of a fabricated list. */
export async function prChangedFiles(number: number): Promise<PrChangedFile[]> {
  return tauriInvoke<PrChangedFile[]>('pr_changed_files', { number }, []);
}

/** All PR Review runs for the active project, newest first. `[]` outside Tauri. */
export async function listPrReviewRuns(): Promise<PrReviewRun[]> {
  return tauriInvoke<PrReviewRun[]>('list_pr_review_runs', {}, []);
}

/** One PR Review run by id, or `null`. `null` outside Tauri. */
export async function getPrReviewRun(runId: string): Promise<PrReviewRun | null> {
  return tauriInvoke<PrReviewRun | null>('get_pr_review_run', { runId }, null);
}

/** Mark a review finding dismissed (it stays dismissed across future re-runs).
 *  Returns the updated run. No-op (`null`) outside Tauri. */
export async function dismissReviewFinding(
  runId: string,
  findingId: string,
): Promise<PrReviewRun | null> {
  return tauriInvoke<PrReviewRun | null>(
    'dismiss_review_finding',
    { runId, findingId },
    null,
  );
}

/** Restore a dismissed review finding back to open. Returns the updated run. */
export async function restoreReviewFinding(
  runId: string,
  findingId: string,
): Promise<PrReviewRun | null> {
  return tauriInvoke<PrReviewRun | null>(
    'restore_review_finding',
    { runId, findingId },
    null,
  );
}

/** Convert a review finding into a board task (idempotent). Returns the created task. */
export async function convertReviewFindingToTask(
  runId: string,
  findingId: string,
): Promise<Task> {
  return invoke<Task>('convert_review_finding_to_task', { runId, findingId });
}

/** Delete a PR Review run and its file. No-op outside Tauri. */
export async function deletePrReviewRun(runId: string): Promise<void> {
  await tauriInvoke<void>('delete_pr_review_run', { runId }, undefined);
}

/** Post a review to GitHub — the terminal, human-gated action. The Rust core
 *  composes ONE `gh api POST …/reviews` carrying `{event, body, comments[]}`.
 *  `verdict` is the web kebab form; `body` + `comments` are Nightcore-composed from
 *  the SELECTED findings (our own trusted text — never raw foreign diff). The
 *  optional `runId` stamps the originating run's `postedVerdict` / `postedAt` on
 *  a successful post (the Rust command takes an optional run id). Uses raw
 *  `invoke` (like {@link applyHarnessArtifact}) so a gh failure surfaces to the
 *  caller. Rejects outside Tauri (no active project). */
export async function postReviewToGithub(
  prNumber: number,
  verdict: ReviewVerdict,
  body: string,
  comments: ReviewInlineComment[],
  runId?: string | null,
): Promise<void> {
  await invoke<void>('post_review_to_github', {
    prNumber,
    verdict,
    body,
    comments,
    runId: runId ?? null,
  });
}

// --- PR fix (address review findings) --------------------------------------

/** Run a fix agent over the SELECTED findings of a review run, on the PR's own
 *  branch. Returns the fix id the `nc:pr-fix` snapshots correlate by. The session
 *  auto-commits on completion and parks at `awaiting_push` — {@link pushPrFix} is
 *  the separate human-gated publish. Uses raw `invoke` (like {@link startPrReview})
 *  so a refusal (fork PR / missing checkout / a fix already running on this PR)
 *  surfaces to the caller. Rejects outside Tauri. */
export async function addressReviewFindings(
  runId: string,
  findingIds: string[],
): Promise<string> {
  return invoke<string>('address_review_findings', { runId, findingIds });
}

/** Push an `awaiting_push` fix's branch to origin — THE human-gated external side
 *  effect of the fix arc (plain push, never force; a diverged remote fails loudly).
 *  Raw `invoke` so a gh/git failure surfaces to the caller. Rejects outside Tauri. */
export async function pushPrFix(fixId: string): Promise<void> {
  await invoke<void>('push_pr_fix', { fixId });
}

/** Every registered fix, newest first. The registry is in-memory Rust-side — an
 *  app restart forgets entries (the commit survives on the branch). `[]` outside
 *  Tauri. */
export async function listPrFixes(): Promise<PrFixState[]> {
  return tauriInvoke<PrFixState[]>('list_pr_fixes', {}, []);
}

/** Cancel a running fix (interrupts the session; the fix lands as
 *  `failed("cancelled")` on `nc:pr-fix`). No-op outside Tauri. */
export async function cancelPrFix(fixId: string): Promise<void> {
  await tauriInvoke<void>('cancel_pr_fix', { fixId }, undefined);
}

// --- Readiness Scorecard (Profile) ----------------------------------------

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

// --- Harness (codebase convention auditor) --------------------------------

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

/** Convert a convention finding into a board task (idempotent). Returns the created
 *  task. Uses raw `invoke` (throws outside Tauri), mirroring `convertFindingToTask`. */
export async function convertHarnessFindingToTask(
  runId: string,
  findingId: string,
): Promise<Task> {
  return invoke<Task>('convert_harness_finding_to_task', { runId, findingId });
}

/** Mark a task-shaped proposal dismissed (it stays dismissed across future
 *  re-scans). Returns the updated run. No-op (`null`) outside Tauri. */
export async function dismissHarnessProposal(
  runId: string,
  proposalId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'dismiss_harness_proposal',
    { runId, proposalId },
    null,
  );
}

/** Restore a dismissed proposal back to proposed. Returns the updated run. */
export async function restoreHarnessProposal(
  runId: string,
  proposalId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'restore_harness_proposal',
    { runId, proposalId },
    null,
  );
}

/** Convert a task-shaped proposal into a board task (idempotent). Returns the created
 *  task. Uses raw `invoke` (throws outside Tauri), mirroring `convertHarnessFindingToTask`. */
export async function convertHarnessProposal(
  runId: string,
  proposalId: string,
): Promise<Task> {
  return invoke<Task>('convert_harness_proposal', { runId, proposalId });
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

/** Apply an `apply-artifacts` proposal as a bundle — WRITES every referenced artifact to
 *  disk through the same hardened path as {@link applyHarnessArtifact}, then marks the
 *  proposal applied. Idempotent + partial-failure-aware (a failed write leaves the
 *  succeeded artifacts applied and rejects with the error). Rejecting an `agent-task`
 *  proposal (no artifacts) is expected — convert it instead. Rejects outside Tauri. */
export async function applyHarnessProposal(
  runId: string,
  proposalId: string,
): Promise<HarnessRun> {
  return invoke<HarnessRun>('apply_harness_proposal', { runId, proposalId });
}

/** Arm a Structure-Lock check into the scanned project's `.nightcore/harness.json` so
 *  the zero-cost gauntlet runs it before every future reviewer + at merge. The `command`
 *  is what the user reviewed and confirmed (the human gate) — never model-derived. Uses
 *  raw `invoke` (throws outside Tauri) so a failed write surfaces to the caller. */
export async function armHarnessGauntletCheck(
  runId: string,
  name: string,
  kind: string,
  command: string,
): Promise<void> {
  await invoke<void>('arm_harness_gauntlet_check', { runId, name, kind, command });
}

// --- Harness policy authoring + injection scan ------------------------------

/** Read the ACTIVE project's harness policy block (`.nightcore/harness.json`),
 *  with defaults when the manifest/key is absent; `manifestExists` tells the
 *  editor whether saving edits or creates the file. Returns a mock outside Tauri. */
export async function getHarnessPolicyFile(): Promise<HarnessPolicyFile> {
  return tauriInvoke<HarnessPolicyFile>('get_harness_policy_file', {}, MOCK_POLICY_FILE);
}

/** Merge a policy patch into the active project's `.nightcore/harness.json` —
 *  WRITES to disk (creating the manifest when absent) and returns the updated
 *  policy. Only the keys present in the patch change; unknown manifest keys
 *  survive. Uses raw `invoke` (throws outside Tauri) so a failed write surfaces
 *  to the caller instead of silently "saving". */
export async function updateHarnessPolicyFile(
  patch: HarnessPolicyPatch,
): Promise<HarnessPolicyFile> {
  return invoke<HarnessPolicyFile>('update_harness_policy_file', { patch });
}

/** Sweep the active project's git-tracked text files for prompt-injection-shaped
 *  content (invisible Unicode tags, zero-width runs, bidi overrides, instruction
 *  phrases), returning the flagged paths + reasons for human review. Detection
 *  only — quarantining is the user's explicit denyReadPaths update. Returns mock
 *  flags outside Tauri. */
export async function scanInjectionSurface(): Promise<InjectionFlag[]> {
  return tauriInvoke<InjectionFlag[]>('scan_injection_surface', {}, MOCK_INJECTION_FLAGS);
}
