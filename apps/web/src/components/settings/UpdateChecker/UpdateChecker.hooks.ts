/** Update check/install state for Settings → About and the startup probe. */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type AppUpdateInfo,
  checkForAppUpdate,
  clearCachedAppUpdate,
  installCachedAppUpdate,
  isTauri,
  type UpdateDownloadEvent,
} from '@/lib/bridge';

import type { UpdateCheckerProps, UpdateCheckerStatus } from './UpdateChecker.types';

const STARTUP_DELAY_MS = 30_000;

export interface UpdateCheckerState {
  status: UpdateCheckerStatus;
  update: AppUpdateInfo | null;
  progressPct: number | null;
  error: string | null;
  isTauriRuntime: boolean;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

/** Owns updater check/install lifecycle and the optional delayed startup probe. */
export function useUpdateChecker({
  isAppIdle,
  checkOnStartup = false,
}: UpdateCheckerProps): UpdateCheckerState {
  const [status, setStatus] = useState<UpdateCheckerStatus>('idle');
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null);
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startupRan = useRef(false);
  const isTauriRuntime = isTauri();

  const check = useCallback(async () => {
    if (!isTauriRuntime) return;
    setStatus('checking');
    setError(null);
    setProgressPct(null);
    try {
      const found = await checkForAppUpdate();
      if (!found) {
        setUpdate(null);
        setStatus('up-to-date');
        return;
      }
      setUpdate(found);
      setStatus(isAppIdle ? 'available' : 'deferred');
    } catch (err) {
      setUpdate(null);
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Update check failed');
    }
  }, [isAppIdle, isTauriRuntime]);

  const install = useCallback(async () => {
    if (!isTauriRuntime || !update) return;
    if (!isAppIdle) {
      setStatus('deferred');
      return;
    }
    setStatus('installing');
    setError(null);
    setProgressPct(0);
    let total = 0;
    let downloaded = 0;
    try {
      await installCachedAppUpdate((event: UpdateDownloadEvent) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
          downloaded = 0;
          setProgressPct(total > 0 ? 0 : null);
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            setProgressPct(Math.min(100, Math.round((downloaded / total) * 100)));
          }
        } else if (event.event === 'Finished') {
          setProgressPct(100);
        }
      });
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Update install failed');
      await clearCachedAppUpdate();
    }
  }, [isAppIdle, isTauriRuntime, update]);

  const dismiss = useCallback(() => {
    setStatus('idle');
    setUpdate(null);
    setError(null);
    setProgressPct(null);
    void clearCachedAppUpdate();
  }, []);

  useEffect(() => {
    if (!checkOnStartup || !isTauriRuntime || startupRan.current) return;
    startupRan.current = true;
    const timer = window.setTimeout(() => {
      void check();
    }, STARTUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [check, checkOnStartup, isTauriRuntime]);

  useEffect(() => {
    if (update && !isAppIdle && (status === 'available' || status === 'installing')) {
      setStatus('deferred');
    } else if (update && isAppIdle && status === 'deferred') {
      setStatus('available');
    }
  }, [isAppIdle, status, update]);

  return {
    status,
    update,
    progressPct,
    error,
    isTauriRuntime,
    check,
    install,
    dismiss,
  };
}