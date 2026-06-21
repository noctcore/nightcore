import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

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
}

/** Global settings + per-project overrides. Mirrors the Rust `Settings` struct. */
export interface Settings {
  defaultModel: string;
  defaultEffort: string;
  maxConcurrency: number;
  permissionMode: string;
  theme: string;
  cleanupWorktrees: boolean;
  notifyOnComplete: boolean;
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
  theme?: string;
  cleanupWorktrees?: boolean;
  notifyOnComplete?: boolean;
}

/** `nc:project` payload: a registry change plus the full registry snapshot. */
export interface ProjectEnvelope {
  type: 'created' | 'deleted' | 'activated';
  project: Project | null;
  projects: Project[];
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
  defaultModel: 'opus-4.8',
  defaultEffort: 'medium',
  maxConcurrency: 3,
  permissionMode: 'auto-accept',
  theme: 'cosmic',
  cleanupWorktrees: true,
  notifyOnComplete: false,
  projectOverrides: {},
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
