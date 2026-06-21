import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** True when running inside the Tauri webview (vs. a plain browser preview). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Lifecycle status of a task. Mirrors the Rust `TaskStatus` enum exactly. */
export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'waiting_approval'
  | 'done'
  | 'failed';

/** The shared task shape. Mirrors the Rust serde struct (camelCase) exactly. */
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  model: string | null;
  createdAt: number;
  updatedAt: number;
  sessionId: number | null;
  summary: string | null;
  error: string | null;
  costUsd: number | null;
}

/** Partial update sent to `update_task`. All fields optional. */
export interface TaskPatch {
  title?: string;
  description?: string;
  status?: TaskStatus;
  dependencies?: string[];
  model?: string | null;
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

// --- Commands -------------------------------------------------------------

/** Load all persisted tasks. Returns `[]` outside Tauri (browser preview). */
export async function listTasks(): Promise<Task[]> {
  if (!isTauri()) return [];
  return invoke<Task[]>('list_tasks');
}

/** Create a new `backlog` task. No-op (throws) outside Tauri. */
export async function createTask(
  title: string,
  description: string,
): Promise<Task> {
  return invoke<Task>('create_task', { title, description });
}

/** Apply a partial update to a task. */
export async function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  return invoke<Task>('update_task', { id, patch });
}

/** Delete a task. */
export async function deleteTask(id: string): Promise<void> {
  await invoke('delete_task', { id });
}

/** Run a task through the sidecar. Rejects if a task is already running. */
export async function runTask(id: string): Promise<void> {
  await invoke('run_task', { id });
}

/** Best-effort interrupt of the current run. */
export async function cancelTask(id: string): Promise<void> {
  await invoke('cancel_task', { id });
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
