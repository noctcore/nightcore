/** Bridge commands — the per-task Trust Report (wayfinder #91). Thin wrappers over
 *  the `trust_report` / `trust_report_markdown` / `write_trust_report` Tauri
 *  commands, all of which aggregate + render on demand from the persisted task,
 *  its flight-recorder ledger, and its transcript (never persisted). Outside the
 *  Tauri webview (browser preview / stories) they resolve quiet sentinels so the
 *  Trust band degrades to its unavailable note instead of rejecting. */
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

import { isTauri, tauriInvoke } from '../internal';
import type { TrustReport } from '../types';

/** Compute the structured Trust Report for a task — the drawer's Trust band renders
 *  it natively. `null` outside Tauri (browser preview). */
export async function trustReport(taskId: string): Promise<TrustReport | null> {
  return tauriInvoke<TrustReport | null>('trust_report', { taskId }, null);
}

/** Render the Trust Report as canonical markdown (the ONE Rust renderer). `forGithub`
 *  wraps it with the house header/footer + GitHub-safe fencing (PR 3); the in-drawer
 *  preview passes `false`. Empty string outside Tauri. */
export async function trustReportMarkdown(
  taskId: string,
  forGithub: boolean = false,
): Promise<string> {
  return tauriInvoke<string>('trust_report_markdown', { taskId, forGithub }, '');
}

/** The outcome of an export: whether the user completed the save, and the path
 *  chosen (for the success note). */
export interface TrustExportResult {
  /** True once the markdown was written to `path`; false when the user cancelled
   *  the native save dialog or the call ran outside Tauri. */
  saved: boolean;
  /** The absolute path written to, or `null` when nothing was saved. */
  path: string | null;
}

/** Export the Trust Report to a user-chosen `*.md` file: open the native save
 *  dialog, then have Rust render + atomically write the canonical markdown to the
 *  chosen path (`write_trust_report`). Keeping the write Rust-side preserves the ONE
 *  canonical renderer while the path choice stays a native dialog — no browser-
 *  download idiom, no new dependency. Resolves `{ saved: false }` when the user
 *  cancels or outside Tauri (browser preview). */
export async function exportTrustReport(
  taskId: string,
  suggestedName: string,
): Promise<TrustExportResult> {
  if (!isTauri()) return { saved: false, path: null };
  const dest = await save({
    title: 'Export Trust Report',
    defaultPath: `${suggestedName}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (dest === null) return { saved: false, path: null };
  await invoke('write_trust_report', { taskId, destPath: dest });
  return { saved: true, path: dest };
}
