/** Bridge commands — in-app updater (check, download, install, relaunch). */
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';

import { isTauri } from '../internal';

export type { DownloadEvent as UpdateDownloadEvent };

/** Summary of an available update returned to UI layers. */
export interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
}

/** The cached `Update` handle between check and install — lives in the bridge seam. */
let cachedUpdate: Update | null = null;

/** Drop any cached update handle from a prior check. */
export async function clearCachedAppUpdate(): Promise<void> {
  if (!cachedUpdate) return;
  await cachedUpdate.close().catch(() => {});
  cachedUpdate = null;
}

/** Check GitHub Releases for a newer build. Returns `null` when up to date or outside Tauri. */
export async function checkForAppUpdate(): Promise<AppUpdateInfo | null> {
  if (!isTauri()) return null;
  await clearCachedAppUpdate();
  const update = await check();
  if (!update) return null;
  cachedUpdate = update;
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: update.body,
  };
}

/** Download and install the cached update, then relaunch into the new version. */
export async function installCachedAppUpdate(
  onProgress?: (event: DownloadEvent) => void,
): Promise<void> {
  if (!isTauri()) return;
  if (!cachedUpdate) {
    throw new Error('No update is cached — check for updates first');
  }
  await cachedUpdate.downloadAndInstall(onProgress);
  await clearCachedAppUpdate();
  await relaunch();
}