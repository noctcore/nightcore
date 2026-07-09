/**
 * The Codex provider's capability descriptor (issue #18, Phase 4 — the
 * second-provider spike that validates the seam).
 *
 * This is the real Codex capability descriptor. Codex still has no PreToolUse hook
 * seam, but it does ship native sandbox/approval controls; Nightcore treats those
 * as provider-owned write containment for the elevated `auto-accept` posture.
 *
 *  - `supportsHooks: false` — there is no Claude-style PreToolUse gate.
 *  - `providesOwnWriteContainment: true` — Codex's native sandbox is the
 *    compensating control for `workspace-write` autonomy.
 *  - `autonomyLevels: ['auto-accept', 'ask', 'plan']` — `bypass` stays hidden until
 *    an explicit process-level opt-in enables danger-full-access.
 *  - `costTelemetry: 'tokens-only'` — Codex reports usage tokens, not dollars.
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
 * The truthful Codex capability matrix. Complete by design — every flag is present
 * — so orchestration and the UI degrade from THIS descriptor, never from the
 * provider id.
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
  id: CODEX_PROVIDER_ID,
  label: CODEX_PROVIDER_LABEL,
  autonomyLevels: ['auto-accept', 'ask', 'plan'],
  supportsHooks: false,
  providesOwnWriteContainment: true,
  supportsMcp: true,
  supportsPlanMode: true,
  supportsStructuredOutput: true,
  supportsSessionResume: true,
  supportsFileCheckpointing: false,
  supportsAskUserQuestion: false,
  supportsSettingSources: true,
  supportsSessionStore: true,
  supportsEffort: true,
  costTelemetry: 'tokens-only',
};
