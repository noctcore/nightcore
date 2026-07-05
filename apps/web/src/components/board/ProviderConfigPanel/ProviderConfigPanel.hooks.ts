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
 *  and a `reload` for the retry affordance. Fetches when the panel opens and
 *  refetches when the path changes — the panel now stays mounted while closed (to
 *  animate its exit), so the fetch is gated on `open` to avoid a closed-panel read. */
export function useProviderConfig(
  open: boolean,
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

  useEffect(() => {
    if (!open) return;
    return load();
  }, [load, open]);

  const reload = useCallback(() => {
    load();
  }, [load]);

  return { snapshot, loading, error, reload };
}
