/**
 * The Codex provider's capability descriptor (issue #18, Phase 4).
 *
 * The real, shipped Codex capability descriptor — the second provider running behind
 * the neutral agent-provider seam. Codex has no PreToolUse hook seam, but it does
 * ship native sandbox/approval controls; Nightcore treats those as provider-owned
 * write containment for the elevated `auto-accept` posture.
 *
 *  - `supportsHooks: false` — there is no Claude-style PreToolUse gate.
 *  - `providesOwnWriteContainment: true` — Codex's native sandbox is the
 *    compensating control for `workspace-write` autonomy.
 *  - `supportsHarnessPolicy: false` — a project's Harness runtime policy (protected
 *    paths + Bash-command deny tiers) rides Claude's PreToolUse hook; Codex has no
 *    equivalent seam today, so a run whose policy is ARMED (present and non-empty)
 *    is REFUSED fail-closed rather than silently running ungoverned (issue #296).
 *    A real interception point (`codex app-server`'s `execCommandApproval`/
 *    `applyPatchApproval` RPCs) exists one layer below the `@openai/codex-sdk`
 *    Nightcore drives today, but wiring it is a separate, larger initiative
 *    (#304) — Codex's own kernel sandbox (`providesOwnWriteContainment`) is a
 *    real but PARTIAL compensating control: it covers workspace confinement, not
 *    a project's custom protected-path/deny-pattern rules.
 *  - `supportsLedger: false` — declared truthfully (Codex can't write the
 *    flight-recorder audit ledger either) but is NOT currently a refusal trigger:
 *    the ledger path is set unconditionally for every project-scoped run, never an
 *    "armed" signal — see `assertGovernanceInvariant`'s docblock in
 *    `providers/agent-provider.ts`.
 *  - `autonomyLevels: ['auto-accept', 'plan']` — `ask` is NOT advertised: the
 *    codex-sdk has no approval channel (non-interactive `codex exec`, stdin closed,
 *    no approval event), so an `ask` posture could never be answered and would hang.
 *    Offering it in the picker would be a deadlock trap, so the real supported set
 *    omits it. `bypass` stays hidden until an explicit process-level opt-in enables
 *    danger-full-access.
 *  - `costTelemetry: 'tokens-only'` — Codex reports usage tokens, not dollars.
 *  - `supportsMaxTurns: false` / `supportsMaxBudget: false` — Codex's
 *    `@openai/codex-sdk` `TurnOptions` exposes only `outputSchema` + `signal`, so a
 *    turn or budget ceiling can't be honored; these are declared false rather than
 *    silently ignored so the UI can caveat the controls (issue #296 item 5).
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
  autonomyLevels: ['auto-accept', 'plan'],
  supportsHooks: false,
  providesOwnWriteContainment: true,
  supportsHarnessPolicy: false,
  supportsLedger: false,
  supportsMcp: true,
  supportsPlanMode: true,
  supportsStructuredOutput: true,
  supportsSessionResume: true,
  supportsFileCheckpointing: false,
  supportsAskUserQuestion: false,
  supportsSettingSources: true,
  supportsSessionStore: true,
  supportsEffort: true,
  supportsMaxTurns: false,
  supportsMaxBudget: false,
  costTelemetry: 'tokens-only',
};
