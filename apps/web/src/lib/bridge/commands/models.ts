/** Bridge commands — the merged dynamic model catalog + the default provider's
 *  capability descriptor. Both back the shared model picker (`ui/ModelSelect`): the catalog
 *  populates the provider-grouped listbox, the capabilities gate the reasoning-effort
 *  row (`supportsEffort`) and the surfaces' cost lines (`costTelemetry`). */
import { tauriInvoke } from '../internal';
import { MOCK_CAPABILITIES, MOCK_MODEL_CATALOG } from '../mocks';
import type { ModelDescriptor, ProviderCapabilities } from '../types';

/** The merged dynamic model catalog (issue #80, `list_models`), fetched
 *  live from the engine provider registry and cached engine-side.
 *  Pass `refresh` to bypass the fresh-cache read and re-probe. Outside Tauri
 *  (browser preview / Storybook) it degrades to the curated static catalog. */
export async function listModels(refresh = false): Promise<ModelDescriptor[]> {
  const models = await tauriInvoke<ModelDescriptor[]>('list_models', { refresh }, MOCK_MODEL_CATALOG);
  // Defend the picker against a malformed reply: the catalog contract is an array,
  // but a misbehaving backend (or a partial invoke mock) could yield a non-array,
  // which would make `ModelSelect` iterate a non-iterable and crash. Coerce to the
  // static fallback so the picker degrades to a working catalog instead.
  return Array.isArray(models) ? models : MOCK_MODEL_CATALOG;
}

/** The default provider's capability descriptor (issue #18, `get_capabilities`) — the
 *  provider-static support matrix the UI degrades from. Outside Tauri it degrades to
 *  the Claude fallback; this is ALSO the fail-open default a caller uses when the
 *  live read fails (a missing capability must never silently drop a control). */
export async function getCapabilities(): Promise<ProviderCapabilities> {
  return tauriInvoke<ProviderCapabilities>('get_capabilities', {}, MOCK_CAPABILITIES);
}
