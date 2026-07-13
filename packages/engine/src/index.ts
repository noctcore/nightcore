/**
 * @nightcore/engine — public façade.
 *
 * Surfaces import ONLY from here (plus `@nightcore/contracts` for types). The
 * SDK is never re-exported: `SessionManager` is the entire surface a client
 * needs to drive the engine via `SurfaceCommand`s and consume `NightcoreEvent`s
 * — and it is the ONLY export with a production consumer (the sidecar).
 *
 * Everything else in the engine (the scan managers, presets, parse/ground/dedup
 * helpers, the policy layers, the SDK adapter) is internal: the engine's own
 * tests import those modules via their source paths, never through this barrel.
 * Do not re-add zero-consumer re-exports here — dead façade surface hides what
 * the package actually promises (audit issue #43).
 *
 * The ONE deliberate exception is the Council debate surface below: unlike the scan
 * internals it is a distinct, consumer-backed sub-façade (`./debate`) — the
 * `start-council`/`kill-council` command family is driven through `SessionManager`,
 * and the canvas bridge (#352) is its imminent external consumer. It re-exports its
 * own curated names (not `export *`), so it stays a promise, not dead surface.
 */
export * from './debate/index.js';
export { SessionManager } from './session/session-manager.js';
