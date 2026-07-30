/** Bridge commands — tasks, transcript persistence, and SDK session history. */
import { invoke } from '@tauri-apps/api/core';

import { NightcoreEventSchema } from '@nightcore/contracts';

import type { NewAttachmentPayload } from '../../attachments';
import { tauriInvoke } from '../internal';
import type {
  NcEvent,
  PermissionMode,
  RunMode,
  RunOrderProjection,
  SessionInfo,
  SessionMessage,
  Task,
  TaskKind,
  TaskPatch,
  TaskStatus,
} from '../types';

/** Load all persisted tasks. Returns `[]` outside Tauri (browser preview). */
export async function listTasks(): Promise<Task[]> {
  return tauriInvoke<Task[]>('list_tasks', {}, []);
}

/** Optional per-task launch overrides settable at create time. All
 *  default to `null` = inherit the resolved project/global default. */
export interface CreateTaskOptions {
  permissionMode?: PermissionMode | null;
  /** Plan-approval gate (T6, #147): the per-task "Plan first" toggle. `true` FORCES
   *  plan mode, `false` WAIVES the Build default, `undefined`/`null` = no per-task
   *  signal (the Rust submit path applies the Build + `planGateDefault` default). */
  planFirst?: boolean | null;
  model?: string | null;
  /** The provider the picked model belongs to (B5), so a created task round-trips
   *  its selection's provider. `undefined` ⇒ omit (derive from the model id). */
  providerId?: string;
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
    planFirst: options.planFirst ?? null,
    model: options.model ?? null,
    providerId: options.providerId ?? null,
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

/** Duplicate a task (T13: re-run-with-tweaks). Mints a fresh backlog task cloning the
 *  source's prompt + launch config + image attachments (not its run state or deps),
 *  returning the clone so the caller can select it for editing. No-op (throws) outside
 *  Tauri. */
export async function duplicateTask(id: string): Promise<Task> {
  return invoke<Task>('duplicate_task', { id });
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

/** An empty run-order projection — the browser-preview fallback and the shape a
 *  failed fetch degrades to (the board then simply shows no ordering hints rather
 *  than a wrong one). */
const EMPTY_RUN_ORDER: RunOrderProjection = {
  entries: [],
  unreachable: [],
  freeSlots: 0,
  maxConcurrency: 0,
  startsNowCount: 0,
};

/** The coordinator's PROJECTED execution order (#402): launchable tasks in the order
 *  the auto-loop will pick them up, wave by wave, plus the live slot context. Wave 0
 *  is exactly what the next tick launches, so `startsNowCount` answers "arming Auto
 *  Mode now starts N tasks" before arming. Read-only. Returns an empty projection
 *  outside Tauri (browser preview). */
export async function runOrder(): Promise<RunOrderProjection> {
  return tauriInvoke<RunOrderProjection>('run_order', {}, EMPTY_RUN_ORDER);
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

/** One page of a task's persisted transcript, newest page first. `nextCursor` is an
 *  opaque byte offset into the JSONL: pass it back as `before` to read the page
 *  immediately OLDER than this one. It is stable under append (the transcript is
 *  append-only), so a live run writing more lines never shifts a held cursor. */
export interface TranscriptPage {
  events: NcEvent[];
  nextCursor: number | null;
  hasMore: boolean;
}

/** The empty page — outside Tauri (browser preview) and for a task with no
 *  transcript yet. Frozen so a caller can't mutate the shared literal. */
const EMPTY_TRANSCRIPT_PAGE: TranscriptPage = Object.freeze({
  events: [],
  nextCursor: null,
  hasMore: false,
});

/** Read ONE page of a task's persisted session transcript — the same `NcEvent`s that
 *  streamed over `nc:session`, appended to a per-task JSONL by the core. The web
 *  reseeds the stream view from this on task open/mount so a reload/HMR no longer
 *  blanks the transcript.
 *
 *  `limit` bounds the page (the core clamps it to its own tail ceiling; omitted ⇒ the
 *  whole window) and `before` continues from a previous page's `nextCursor`. Paging
 *  exists so the reseed never hands the webview one multi-MB hop: the surface takes a
 *  small first page and walks older pages on its own schedule (#407).
 *
 *  Returns the empty page outside Tauri (browser preview) and tolerates a
 *  missing/empty transcript. */
export async function readTranscript(
  taskId: string,
  opts: { limit?: number; before?: number | null } = {},
): Promise<TranscriptPage> {
  const raw = await tauriInvoke<unknown>(
    'read_transcript',
    { taskId, limit: opts.limit, before: opts.before ?? null },
    EMPTY_TRANSCRIPT_PAGE,
  );
  if (raw === null || typeof raw !== 'object') return EMPTY_TRANSCRIPT_PAGE;
  const page = raw as { events?: unknown; nextCursor?: unknown; hasMore?: unknown };
  if (!Array.isArray(page.events)) return EMPTY_TRANSCRIPT_PAGE;
  // Validate each persisted line against the authoritative event contract,
  // dropping any entry that fails (a partial write / legacy variant) rather than
  // feeding a malformed event into `foldSession`.
  const events: NcEvent[] = [];
  for (const entry of page.events) {
    const parsed = NightcoreEventSchema.safeParse(entry);
    if (parsed.success) events.push(parsed.data);
  }
  return {
    events,
    nextCursor: typeof page.nextCursor === 'number' ? page.nextCursor : null,
    hasMore: page.hasMore === true,
  };
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

