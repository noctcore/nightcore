/** The live data seams for {@link ModelSelectField}: the async model-catalog loader
 *  (over the `list_models` bridge) and the provider-capability probe (over
 *  `get_capabilities`). Kept out of the `.tsx` shell so the wrapper stays a thin
 *  presentation layer over the pure `ui/ModelSelect`. */
import { useEffect, useState } from 'react';

import { getCapabilities, listModels, type ProviderCapabilities } from '@/lib/bridge';
import { cacheProviderCapabilities, KNOWN_PROVIDER_IDS } from '@/lib/provider-capabilities';

import type { ModelCatalogData } from '../ModelSelect';

/** The LIVE catalog seam — the `async` variant of {@link ModelCatalogData} that
 *  loads the dynamic merged catalog via the `list_models` bridge
 *  command. A stable module const so `useModelCatalog` fetches once per mount (its
 *  effect keys on `data.mode`); outside Tauri the bridge degrades to the static
 *  catalog, so the picker still renders in preview. */
export const LIVE_MODEL_CATALOG_DATA: ModelCatalogData = {
  mode: 'async',
  load: () => listModels(),
};

/**
 * Fetch-once memo for the default provider capability descriptor. Capabilities are
 * provider-static, so
 * a single probe is shared across every mounted picker/cost-line instead of one
 * engine round-trip per surface mount. Fail-OPEN: a failed read resolves to `null`
 * (not a throw), and every consumer treats `null` as "assume supported" so a
 * transient probe failure never silently drops the effort control or a cost line.
 */
let capabilitiesMemo: Promise<ProviderCapabilities | null> | null = null;

function loadCapabilitiesOnce(): Promise<ProviderCapabilities | null> {
  capabilitiesMemo ??= (async () => {
    // Prime the per-provider cache for every KNOWN provider so
    // `capabilitiesForProvider(providerId, …)` resolves synchronously later (the
    // create-task form reads it during render). Each descriptor is cached under its
    // OWN id, so an outside-Tauri / fail-open Claude reply for a non-Claude request
    // lands under `claude`, never masquerading as the requested provider. Fail-safe
    // per entry: a rejected/absent fetch leaves that provider absent (→
    // `capabilitiesForProvider`'s fail-safe null).
    await Promise.all(
      KNOWN_PROVIDER_IDS.map((id) =>
        getCapabilities(id)
          .then((caps) => {
            if (caps) cacheProviderCapabilities(caps);
          })
          .catch(() => {}),
      ),
    );
    // The DEFAULT provider's descriptor backs the hook's return + the `fallback` arg.
    // Coerce a malformed/absent reply (`undefined` from a partial invoke mock) to
    // `null` so every consumer's null fail-open path applies uniformly; cache it
    // under its own id too.
    const def = await getCapabilities()
      .then((caps) => caps ?? null)
      .catch(() => null);
    if (def) cacheProviderCapabilities(def);
    return def;
  })();
  return capabilitiesMemo;
}

/**
 * The default provider's capability descriptor, or `null` while it loads / when the
 * probe failed (fail-open). Consumers gate optional UI on it — the effort row
 * (`supportsEffort`) and the cost lines (`costTelemetry`) — defaulting to "shown"
 * when it is `null`. The underlying probe is memoized module-wide, so many
 * concurrent callers share ONE fetch.
 */
export function useProviderCapabilities(): ProviderCapabilities | null {
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null);
  useEffect(() => {
    let alive = true;
    void loadCapabilitiesOnce().then((next) => {
      if (alive) setCapabilities(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  return capabilities;
}

/**
 * Whether a surface should render its per-run cost line. Gated on the provider's
 * `costTelemetry`: a provider that reports no run cost (`none`) hides the cost
 * affordance, since a "~$X / cost depends on repo size" hint would be misleading.
 * Fail-open — shown while capabilities load and when the probe failed (`null`).
 */
export function useShowCostLine(): boolean {
  const capabilities = useProviderCapabilities();
  return !capabilities || capabilities.costTelemetry !== 'none';
}
