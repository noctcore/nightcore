import type { ProviderCapabilities, ProviderId } from '@nightcore/contracts';

/**
 * The static Claude capability descriptor — the ONLY hand-written provider matrix
 * left in the web tree, kept deliberately: Claude is the safe fail-open default (the
 * web degrades to it outside Tauri and when a live capability read fails), and it
 * seeds the cache below so `capabilitiesForProvider('claude', …)` always resolves
 * synchronously. Every OTHER provider's descriptor is fetched over the wire
 * (`get_capabilities({ providerId })`) and cached — the engine descriptor
 * (`packages/engine/src/providers/<id>/capabilities.ts`) is the single source of
 * truth, so there is no hand-mirrored Codex constant to drift (issue #296 item 6).
 */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  id: 'claude',
  label: 'Claude',
  autonomyLevels: ['bypass', 'auto-accept', 'ask', 'plan'],
  supportsHooks: true,
  providesOwnWriteContainment: false,
  supportsHarnessPolicy: true,
  supportsLedger: true,
  supportsMcp: true,
  supportsPlanMode: true,
  supportsStructuredOutput: true,
  supportsSessionResume: true,
  supportsFileCheckpointing: true,
  supportsAskUserQuestion: true,
  supportsSettingSources: true,
  supportsSessionStore: true,
  supportsEffort: true,
  supportsMaxTurns: true,
  supportsMaxBudget: true,
  costTelemetry: 'full',
};

/** The providers the web primes at startup (see `useProviderCapabilities`). A small
 *  literal set — Claude is the static default; Codex (and any future provider) is
 *  fetched over the wire so its matrix never drifts from the engine descriptor. */
export const KNOWN_PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex'];

/**
 * The fetched-descriptor cache, keyed by provider id — filled by
 * `cacheProviderCapabilities` from live `get_capabilities` fetches. Starts empty:
 * `claude` resolves to the static {@link CLAUDE_CAPABILITIES} default via
 * `capabilitiesForProvider`'s branch until a live descriptor is cached, so the safe
 * Claude default is always available synchronously without a stale seed.
 */
const capabilitiesCache = new Map<string, ProviderCapabilities>();

/**
 * Cache a fetched descriptor, keyed by the descriptor's OWN `id`. Keying by
 * `caps.id` (not the requested id) is the drift/mislabel guard: an outside-Tauri or
 * fail-open reply that returns the Claude fallback for a Codex request lands under
 * `claude`, never under `codex`, so a mismatched reply can never masquerade as the
 * requested provider — the requested provider simply stays absent (fail-safe).
 */
export function cacheProviderCapabilities(caps: ProviderCapabilities): void {
  capabilitiesCache.set(caps.id, caps);
}

/** The cached descriptor for a provider id, or `null` if it hasn't been fetched. */
export function getCachedCapabilities(providerId: string): ProviderCapabilities | null {
  return capabilitiesCache.get(providerId) ?? null;
}

/**
 * Resolve the capability descriptor for a task's provider, synchronously, from the
 * fetched cache. Order:
 *  - no provider picked (`null`/`undefined`) ⇒ the passed `fallback` (the default
 *    provider's descriptor the caller already holds);
 *  - a cached entry ⇒ that fetched descriptor (the engine's truth, over the wire);
 *  - `claude` with no cache entry ⇒ the static `CLAUDE_CAPABILITIES` (or the passed
 *    `fallback` when it is itself Claude's);
 *  - any OTHER provider with no cache entry ⇒ `null`.
 *
 * FAIL-SAFE: a non-Claude provider that isn't cached yet resolves to `null`, NEVER
 * the Claude `fallback`. Returning Claude's matrix for e.g. Codex would wrongly
 * enable the plan gate and hide the governance warning; `null` makes consumers apply
 * their neutral fail-open instead of a wrong provider-specific affordance. The cache
 * is primed at startup (`useProviderCapabilities`), so this miss window is transient.
 */
export function capabilitiesForProvider(
  providerId: ProviderId | null | undefined,
  fallback: ProviderCapabilities | null,
): ProviderCapabilities | null {
  if (providerId === null || providerId === undefined) return fallback;
  const cached = capabilitiesCache.get(providerId);
  if (cached !== undefined) return cached;
  if (providerId === CLAUDE_CAPABILITIES.id) {
    return fallback?.id === providerId ? fallback : CLAUDE_CAPABILITIES;
  }
  return null;
}

/**
 * The create-task caveat (issue #296 item 5) for the per-run `maxTurns` / `maxBudget`
 * controls when the resolved provider can't enforce them (Codex's `@openai/codex-sdk`
 * `TurnOptions` has no turn/budget ceiling). Returns `null` when both are supported
 * or when capabilities are still unknown (`null` ⇒ fail-open, no caveat — the flags
 * gate nothing, they only inform).
 */
export function runCeilingCaveatFor(
  capabilities: ProviderCapabilities | null,
): string | null {
  if (capabilities === null) return null;
  const noTurns = capabilities.supportsMaxTurns === false;
  const noBudget = capabilities.supportsMaxBudget === false;
  if (!noTurns && !noBudget) return null;
  const limits = noTurns && noBudget ? 'turn and budget ceilings' : noTurns ? 'the turn ceiling' : 'the budget ceiling';
  return `${capabilities.label} does not enforce ${limits} — ${
    noTurns && noBudget ? 'these limits' : 'this limit'
  } will be ignored for this run.`;
}
