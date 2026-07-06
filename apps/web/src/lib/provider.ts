/**
 * The active agent provider's user-facing display label — the single web-side
 * swap point for functional copy that names the provider (cost hints, the
 * providers-settings card, native-config help text, "asked" attribution).
 * Mirrors the `providerLabel` field already plumbed end-to-end through
 * `ProviderConfigSnapshot` (the ProviderConfigPanel reads that live value from
 * the backend); this is its static counterpart for surfaces that render before a
 * per-project provider probe exists. Issue #18's provider seam replaces this
 * literal with a capability-driven label.
 *
 * Brand/product taglines (the Splash mark, the "Autonomous Claude dev studio"
 * About subtitle) deliberately keep the literal — they name the product's
 * identity, not the swappable provider.
 */
export const PROVIDER_LABEL = 'Claude';
