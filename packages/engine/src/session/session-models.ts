/**
 * The dynamic model-list probe, extracted from {@link
 * import('./session-manager.js').SessionManager} for the file-size ratchet (behavior
 * verbatim), alongside the existing `session-query` / `session-start-params` splits.
 */
import type { ModelDescriptor } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type { ProviderRegistry } from '../providers/provider-factory.js';

/**
 * List the models every configured provider currently offers (dynamic — fetched at
 * runtime, not hardcoded), each with its supported effort levels. Spins a transient,
 * input-less probe session per provider whose `listModels()` tears its own query
 * down. Degrades to `[]` on any error (logged at debug) — never throws.
 */
export async function probeModels(
  providers: ProviderRegistry,
  logger?: Logger,
): Promise<ModelDescriptor[]> {
  try {
    const models = await Promise.all(
      providers.all().map(async (provider) => {
        try {
          return await provider
            .createProbeSession(logger?.child('model-probe'))
            .listModels();
        } catch (error) {
          logger?.debug('provider listModels() failed; using empty list', {
            providerId: provider.capabilities().id,
            error,
          });
          return [];
        }
      }),
    );
    return models.flat();
  } catch (error) {
    logger?.debug('listModels() failed; returning empty list', error);
    return [];
  }
}
