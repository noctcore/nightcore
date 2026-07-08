/** Bridge commands — projects (list / activate / create / rename / delete / icons) and
 *  the git-repo + folder-picker helpers. */
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

import type { ImageFormat } from '@/lib/attachments';

import { isTauri, tauriInvoke } from '../internal';
import { MOCK_PROJECT } from '../mocks';
import type { Project } from '../types';

/** Patch fields for `update_project` (omitted keys are left unchanged). */
export interface ProjectUpdate {
  name?: string;
  icon?: string;
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

/** Patch a project's name and/or Lucide icon. Emits `nc:project { type: "updated" }`. */
export async function updateProject(id: string, patch: ProjectUpdate): Promise<Project> {
  return invoke<Project>('update_project', { id, ...patch });
}

/** Set a Lucide preset icon; clears any custom image. Emits `updated`. */
export async function setProjectIcon(id: string, icon: string): Promise<Project> {
  return invoke<Project>('set_project_icon', { id, icon });
}

/** Upload a custom icon image. Emits `updated`. */
export async function saveProjectIcon(
  id: string,
  image: { format: ImageFormat; data: string; filename?: string },
): Promise<Project> {
  return invoke<Project>('save_project_icon', {
    id,
    format: image.format,
    data: image.data,
    filename: image.filename ?? null,
  });
}

/** Remove custom icon bytes and clear icon fields. Emits `updated`. */
export async function clearProjectIcon(id: string): Promise<Project> {
  return invoke<Project>('clear_project_icon', { id });
}

/** Read a custom icon as a `data:` URL, or `null` when the project uses a preset. */
export async function readProjectIcon(id: string): Promise<string | null> {
  return tauriInvoke<string | null>('read_project_icon', { id }, null);
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

