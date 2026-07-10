/** Bridge commands — settings, the custom board background, and the pre-flight
 *  context pack. */
import { invoke } from '@tauri-apps/api/core';

import type { ImageFormat } from '../../attachments';
import { imageDataUrl } from '../../attachments';
import { isTauri, tauriInvoke } from '../internal';
import {
  MOCK_APP_INFO,
  MOCK_BACKGROUNDS,
  MOCK_CONTEXT_PACK,
  MOCK_SETTINGS,
  mockSettingsWithBackground,
} from '../mocks';
import type { AppInfo, DetectedEditor, Settings, SettingsPatch } from '../types';

// --- Settings -------------------------------------------------------------

/** The current settings. Returns mock defaults outside Tauri. */
export async function getSettings(): Promise<Settings> {
  return tauriInvoke<Settings>('get_settings', {}, MOCK_SETTINGS);
}

/** The editors detected on this machine (CLI-first: a known editor on PATH) for
 *  the Settings "Open in editor" picker. Returns `[]` outside Tauri (browser
 *  preview) so the picker degrades to just the "Auto" option. */
export async function listEditors(): Promise<DetectedEditor[]> {
  return tauriInvoke<DetectedEditor[]>('list_editors', {}, []);
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

