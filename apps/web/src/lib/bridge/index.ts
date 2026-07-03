/**
 * The web↔Rust bridge: typed wrappers over every Tauri `invoke` command and
 * `nc:*` event subscription the board uses, plus the defensive narrowers that
 * validate event payloads against the authoritative contracts before use. All
 * commands degrade to mock/no-op data outside the Tauri webview (browser preview).
 *
 * This barrel preserves the flat `@/lib/bridge` public surface after the module
 * was split into cohesive submodules (a merge-conflict magnet at ~2k lines):
 *   - `./types`    — generated ts-rs + contract type re-exports
 *   - `./commands` — every `invoke` wrapper + its argument shapes
 *   - `./events`   — every `listen` subscription + zod narrowing + payload types
 *   - `./mocks`    — browser-preview fallbacks
 *   - `./internal` — the shared `isTauri` / `tauriInvoke` helpers
 * Call sites import from `@/lib/bridge` unchanged.
 */
export * from './commands';
export * from './events';
export { isTauri } from './internal';
export { DEFAULT_REPO_URL } from './mocks';
export * from './types';
