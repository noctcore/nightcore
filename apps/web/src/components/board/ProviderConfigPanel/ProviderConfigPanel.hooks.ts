/** Data seam and load lifecycle for the ProviderConfigPanel snapshot. */
import { useCallback, useEffect, useState } from 'react';
import {
  getProviderConfig as bridgeGetProviderConfig,
  type ProviderConfigSnapshot,
} from '@/lib/bridge';
import type { ProviderConfigData } from './ProviderConfigPanel.types';

/** The live data seam — the real bridge. Stories/tests pass an in-memory override
 *  so the panel renders without Tauri. */
export const LIVE_PROVIDER_CONFIG_DATA: ProviderConfigData = {
  load: bridgeGetProviderConfig,
};

/** The async load lifecycle for the inspector snapshot. The snapshot itself
 *  always resolves (sections degrade independently engine-side); `error` is set
 *  only when the WHOLE read failed (no active project, transport down), which the
 *  panel renders as a soft error + retry. */
export interface ProviderConfigState {
  snapshot: ProviderConfigSnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Fetch the provider-config snapshot for `projectPath`, exposing loading/error
 *  and a `reload` for the retry affordance. Refetches when the path changes. */
export function useProviderConfig(
  projectPath: string,
  data: ProviderConfigData,
): ProviderConfigState {
  const [snapshot, setSnapshot] = useState<ProviderConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    data
      .load(projectPath)
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSnapshot(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data, projectPath]);

  useEffect(() => load(), [load]);

  const reload = useCallback(() => {
    load();
  }, [load]);

  return { snapshot, loading, error, reload };
}
