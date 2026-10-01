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
 */
export { SessionManager } from './session/session-manager.js';
