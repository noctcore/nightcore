import { useCallback, useState } from 'react';

import type { ToastApi } from '@/components/ui';
import type { ImageFormat } from '@/lib/attachments';
import {
  clearBoardBackground,
  getSettings,
  setBoardBackground,
  type Settings,
  type SettingsPatch,
  updateSettings,
} from '@/lib/bridge';

import { useAsyncData } from './useAsyncData.hooks';

/** Live settings, kept in memory and patched through `update_settings`. */
export function useSettingsData(toast: ToastApi) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useAsyncData(
    () =>
      getSettings().catch((err) => {
        console.error('get_settings failed', err);
        toast.error('Could not load settings', err);
        return null;
      }),
    (loaded) => {
      if (loaded !== null) setSettings(loaded);
    },
  );

  const update = useCallback(
    (patch: SettingsPatch) => {
      void updateSettings(patch)
        .then(setSettings)
        .catch((err) => {
          console.error('update_settings failed', err);
          // The control snaps back to the last-saved value on failure; surface it
          // so the change isn't silently lost.
          toast.error('Could not save settings', err);
        });
    },
    [toast],
  );

  // Custom Background: persist / clear a project's board background image. Both
  // return the promise so the panel can hold its "Loading…" state until the write
  // settles, and both refresh the in-memory settings from the command result.
  const setBackground = useCallback(
    (projectId: string, image: { format: ImageFormat; data: string }) =>
      setBoardBackground(projectId, image)
        .then(setSettings)
        .catch((err) => {
          console.error('set_board_background failed', err);
          toast.error('Could not set board background', err);
        }),
    [toast],
  );

  const clearBackground = useCallback(
    (projectId: string) =>
      clearBoardBackground(projectId)
        .then(setSettings)
        .catch((err) => {
          console.error('clear_board_background failed', err);
          toast.error('Could not clear board background', err);
        }),
    [toast],
  );

  return { settings, update, setBackground, clearBackground };
}
