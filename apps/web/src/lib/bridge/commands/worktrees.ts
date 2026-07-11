/** Bridge commands — worktrees (list / branches / merge-preview / diff / discard)
 *  and the autonomous loop controls. */
import { invoke } from '@tauri-apps/api/core';

import { tauriInvoke } from '../internal';
import type {
  BranchInfo,
  MergePreview,
  UpdateFromBaseStatus,
  WorktreeDiff,
  WorktreeInfo,
} from '../types';

// --- Worktrees ------------------------------------------------------------

/** The active project's live worktrees — branch, path, grouped task
 *  ids, dirty flag, and ahead-of-base count — driving the worktree switcher's
 *  tabs + monitor indicators. Read-only git status; tolerates a missing/locked
 *  worktree. Returns `[]` outside Tauri (browser preview); the switcher falls
 *  back to distinct task branches there. */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  return tauriInvoke<WorktreeInfo[]>('list_worktrees', {}, []);
}

/** Explicitly reconcile + re-read the active project's worktrees (the board /
 *  Worktrees "Refresh" control). Server-side this prunes orphaned worktrees, clears
 *  ghost branch pointers, and reclaims fully-merged clean worktrees — recovering
 *  from any stale state without an app restart — then returns the fresh statuses.
 *  Emits `nc:task` per reconciled task so the board re-renders. Returns `[]` outside
 *  Tauri (browser preview). */
export async function refreshWorktrees(): Promise<WorktreeInfo[]> {
  return tauriInvoke<WorktreeInfo[]>('refresh_worktrees', {}, []);
}

/** The active project's user-created *terminal* worktrees (spec PR 5) — the "Terminal
 *  worktrees" group in the Worktrees manager. These live under the separate `term/`
 *  namespace (never garbage-collected by the task reconcile sweep) and carry no task ids.
 *  Read-only git status; returns `[]` outside Tauri (browser preview). */
export async function listTerminalWorktrees(): Promise<WorktreeInfo[]> {
  return tauriInvoke<WorktreeInfo[]>('list_terminal_worktrees', {}, []);
}

/** Discard a user-created terminal worktree by `slug` and delete its `term/<slug>` branch
 *  (spec PR 5c). The slug is re-validated + `is_under`-guarded to the terminal base
 *  server-side. Rejects on a real failure (uses raw `invoke`, no silent fallback) so the
 *  discard dialog can surface it; the caller closes any live terminal in the worktree
 *  first (the cleanup interlock). */
export async function discardTerminalWorktree(slug: string): Promise<void> {
  await invoke('discard_terminal_worktree', { slug });
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

/** The unified-diff patch text for ONE changed file in a task's worktree vs base
 *  (T13's per-file patch viewer). `path` is one of the entries {@link worktreeDiff}
 *  returned. Returns `''` outside Tauri (browser preview). */
export async function worktreeFileDiff(id: string, path: string): Promise<string> {
  return tauriInvoke<string>('worktree_file_diff', { id, path }, '');
}

/** Pull the base branch INTO a task's worktree branch — the "Update from base" action
 *  (T13): resolves a stale branch (cut before a base-only commit) before merge. Rejects
 *  on a real failure (still running / dirty worktree) so the caller can surface it; uses
 *  raw `invoke` (no silent fallback). */
export async function updateWorktreeFromBase(id: string): Promise<UpdateFromBaseStatus> {
  return invoke<UpdateFromBaseStatus>('update_worktree_from_base', { id });
}

/** Discard a task's worktree and its branch (safe cleanup, distinct from deleting
 *  the task). Rejects on a real failure (e.g. the task is still running) so the
 *  caller can surface it; uses raw `invoke` (no silent fallback). */
export async function discardWorktree(id: string): Promise<void> {
  await invoke('discard_worktree', { id });
}

/** Reveal a task's worktree directory in the OS file manager (Finder `open -R`).
 *  The path is resolved + confined server-side from the task id (the webview never
 *  supplies a path). Real failures (worktree discarded, opener missing) reject so
 *  the caller can toast; no-ops outside Tauri (browser preview). */
export async function revealWorktree(id: string): Promise<void> {
  await tauriInvoke<void>('reveal_worktree', { id }, undefined);
}

/** Open a task's worktree directory in the user's editor (the Settings-pinned
 *  editor, else CLI-first auto-detect). Path resolved + confined server-side like
 *  {@link revealWorktree}. Rejects when no editor is found so the caller can toast;
 *  no-ops outside Tauri. */
export async function openInEditor(id: string): Promise<void> {
  await tauriInvoke<void>('open_in_editor', { id }, undefined);
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

