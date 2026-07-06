/**
 * The Codex provider's capability descriptor (issue #18, Phase 4 — the
 * second-provider spike that validates the seam).
 *
 * This is a truthful DEGRADED descriptor for a provider that has none of the
 * Claude Agent SDK's control surface. Every flag is chosen to exercise a distinct
 * degradation rule from the issue's table, so wiring a real second provider later
 * has a worked reference:
 *
 *  - `supportsHooks: false`   — THE crux. There is no PreToolUse gate (no workspace
 *    confinement, no deny/ask tiers), so the fail-closed hooks invariant
 *    ({@link ../agent-provider.assertHooksInvariant}) REFUSES the elevated autonomy
 *    ceilings (`bypass` / `auto-accept`) unless an OS sandbox compensates. This is
 *    non-negotiable: confinement is never silently dropped.
 *  - `autonomyLevels: ['ask', 'plan']` — the reduced set. `bypass`/`auto-accept` are
 *    not offered at all; the UI surfaces only the two safe ceilings.
 *  - `supportsStructuredOutput: false` — decompose falls back to the text-JSON parse.
 *  - `supportsMcp` / `supportsSessionStore` / `supportsAskUserQuestion: false` — the
 *    provider-config panel renders these sections `unsupported` ("Not available for
 *    this provider") and questions degrade to permission-style prompts.
 *  - `costTelemetry: 'none'` — surfaces gate their "~$X" cost lines off this rather
 *    than assuming a dollar figure.
 *
 * The descriptor is CONTRACT-ONLY (`ProviderCapabilities`) and imports no SDK — a
 * provider-neutral module by definition (the engine SDK-confinement lint keeps the
 * Claude Agent SDK inside `providers/claude/**`).
 */
import type { ProviderCapabilities } from '@nightcore/contracts';

/** Stable identifier + label for the Codex provider (mirrors the `providers/codex/`
 *  directory slug the design uses). */
export const CODEX_PROVIDER_ID = 'codex';
export const CODEX_PROVIDER_LABEL = 'Codex';

/**
 * The truthful (degraded) Codex capability matrix. Complete by design — every flag
 * is present — but reports the absence of the SDK-backed capabilities Claude has, so
 * orchestration and the UI degrade from THIS descriptor, never from the provider id.
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
  id: CODEX_PROVIDER_ID,
  label: CODEX_PROVIDER_LABEL,
  // The reduced autonomy set: only the two ceilings that prompt (or read-only plan),
  // never the elevated ones the missing PreToolUse gate can't contain.
  autonomyLevels: ['ask', 'plan'],
  // The security crux: no hooks ⇒ sandbox-or-refuse for elevated autonomy.
  supportsHooks: false,
  supportsMcp: false,
  supportsPlanMode: true,
  supportsStructuredOutput: false,
  supportsSessionResume: false,
  supportsFileCheckpointing: false,
  supportsAskUserQuestion: false,
  supportsSettingSources: false,
  supportsSessionStore: false,
  supportsEffort: false,
  costTelemetry: 'none',
};
