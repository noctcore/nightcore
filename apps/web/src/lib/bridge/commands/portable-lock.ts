/** Bridge command — the portable Structure-Lock export (#134 PR 3). A thin wrapper
 *  over the `export_portable_lock` Tauri command: it stages a portable-lock bundle
 *  (a `schemaVersion`-stamped manifest copy + a deterministic `nightcore-lock.yml` CI
 *  workflow + a README) under `.nightcore/export/portable-lock/` and returns the
 *  staging path, the files written, the workflow YAML (for the copy button), and the
 *  pinned runner version. The workflow is STAGED, never auto-written into
 *  `.github/workflows/` — the user copies it in themselves (the ONE manual step).
 *  Degrades to `null` outside the Tauri webview (browser preview / stories) so the
 *  export dialog shows its unavailable note instead of rejecting. */
import { tauriInvoke } from '../internal';
import type { PortableLockExport } from '../types';

/** Stage the portable-lock bundle for `projectPath` and resolve its descriptor. Re-runs
 *  overwrite only the staging dir (idempotent, reviewable via `git diff`). `null`
 *  outside Tauri. */
export async function exportPortableLock(
  projectPath: string,
): Promise<PortableLockExport | null> {
  return tauriInvoke<PortableLockExport | null>('export_portable_lock', { projectPath }, null);
}
