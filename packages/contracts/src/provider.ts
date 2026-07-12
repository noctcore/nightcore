import { z } from 'zod';

/**
 * `provider` — the agent-provider capability contract (issue #18, Phase 0).
 *
 * Nightcore is hard-coupled to the Claude Agent (CLI + Agent SDK). The provider
 * abstraction makes Claude ONE implementation behind a capability-gated seam: a
 * future provider (Codex, Gemini, …) registers with its own {@link
 * ProviderCapabilities} descriptor and the UI/orchestration adapt from the
 * descriptor instead of a `match provider` branch — the same graceful-degradation
 * pattern already proven by the tri-state `provider-config` inspector.
 *
 * This module is CONTRACT-ONLY — it introduces the vocabulary (`ProviderId`,
 * `AutonomyLevel`, `ProviderCapabilities`). The descriptor IS consumed: the web UI
 * degrades from it (the plan-mode gate, the effort row, and the token/cost line each
 * key off a capability flag rather than the provider id) and orchestration reads it
 * to resolve the effective posture — degradation always flows from the descriptor,
 * never from a `match provider` branch (coupling audit §3). Nothing on the NDJSON
 * wire (`SurfaceCommand` / `NightcoreEvent` / `SurfaceQuery`) carries these shapes —
 * they are resolved provider-side (engine + web) — so the zod→Rust codegen
 * (`gen-rust-contracts.ts`) still does not emit them into `generated.rs`; the
 * canonical Rust names stay pre-registered in that emitter's `ENUM_NAMES` for a later
 * wiring phase to emit without a rename. See issue #18.
 */

/**
 * An agent-provider identifier — an OPEN identifier, deliberately NOT a closed
 * enum: new providers register at runtime, so the contract constrains the SHAPE
 * (a lowercase slug) rather than enumerating a fixed set. Today the only value is
 * `claude`; `codex` / `gemini` slot in additively.
 *
 * Consistent with `provider-config`'s already-plumbed `providerId` (a free
 * `string` end-to-end); this adds the slug shape-constraint the issue calls for
 * without narrowing to a fixed union. The pattern — starts with a letter, then
 * lowercase alphanumerics and hyphens — mirrors the package-directory names the
 * design uses (`providers/<id>/`).
 */
export const ProviderIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    'provider id must be a lowercase slug: a letter followed by lowercase letters, digits, or hyphens',
  );
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/**
 * The autonomy ceiling a provider can run under — the settings-layer vocabulary
 * (`bypass | auto-accept | ask | plan`) PROMOTED to the shared contract. This is
 * the provider-neutral vocabulary; each provider maps it to its own primitive
 * (for Claude, the SDK permission modes `bypassPermissions` / `acceptEdits` /
 * `default` / `plan` — a Claude-internal mapping that today leaks into
 * `settings/helpers.rs::sdk_permission_mode` and `plan_approval.rs`).
 *
 * A provider advertises the subset it actually supports via
 * `ProviderCapabilities.autonomyLevels`; a reduced set maps to the nearest
 * primitive and is surfaced in the UI. Kebab/word wire strings, matching the Rust
 * settings `PermissionMode` (`store/task/model.rs`) verbatim.
 */
export const AutonomyLevelSchema = z.enum([
  'bypass',
  'auto-accept',
  'ask',
  'plan',
]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

/**
 * How completely a provider reports the cost of a run:
 *  - `full`        — dollar cost AND token usage (Claude today).
 *  - `tokens-only` — token usage but no monetary figure.
 *  - `none`        — no cost/usage telemetry at all.
 * Surfaces gate the "~$X" cost lines on this rather than assuming a dollar figure.
 */
export const CostTelemetrySchema = z.enum(['full', 'tokens-only', 'none']);
export type CostTelemetry = z.infer<typeof CostTelemetrySchema>;

/**
 * The capability descriptor one provider advertises — capability FLAGS, NOT a
 * lowest-common-denominator interface. Orchestration and the UI read these to
 * degrade gracefully (history says "not available for this provider", the model
 * picker/scan-kind availability adapt) instead of branching on the provider id.
 *
 * Every flag is REQUIRED: a capability descriptor is complete by design — a
 * provider declares its full support matrix, so a missing flag is a contract
 * error, never an implicit `false`. The security-critical one is `supportsHooks`:
 * the PreToolUse confinement + deny/ask/allow gate exists only because the SDK
 * exposes hooks, so `supportsHooks: false` means sandbox-or-refuse (never a silent
 * drop of confinement). That invariant is enforced downstream, not here.
 *
 * `supportsHarnessPolicy` / `supportsLedger` are the same posture applied to a
 * SEPARATE seam (issue #296): a project's Harness runtime policy (protected paths
 * + Bash-command deny tiers) and the flight-recorder audit ledger both ride the
 * SAME PreToolUse hook Claude exposes, but they are governance/audit concerns, not
 * the bypass/auto-accept OS-containment `supportsHooks` already guards — a
 * provider can lack one and not the other in principle, so they are independent
 * flags. `supportsHarnessPolicy: false` means fail-closed REFUSAL of a run whose
 * Harness policy is ARMED (enforced downstream by `assertGovernanceInvariant`).
 * `supportsLedger: false` is declared truthfully but is NOT currently a refusal
 * trigger: the ledger path is set unconditionally per project (not an "armed"
 * signal the way the policy is), so there is nothing to gate on yet — see
 * `assertGovernanceInvariant`'s docblock. It exists for descriptor completeness
 * and #304's real-enforcement follow-up.
 */
export const ProviderCapabilitiesSchema = z.object({
  /** Stable provider identifier (`claude`, `codex`, …). */
  id: ProviderIdSchema,
  /** Human-readable label for the provider (`Claude`). */
  label: z.string(),
  /** The autonomy ceilings this provider supports (subset of AutonomyLevel). */
  autonomyLevels: z.array(AutonomyLevelSchema),
  /** PreToolUse hooks — the workspace-confinement + deny/ask/allow gate seam. */
  supportsHooks: z.boolean(),
  /** Provider-native write containment that can compensate for missing hooks. */
  providesOwnWriteContainment: z.boolean().default(false),
  /** Can enforce a project's Harness runtime policy (protected paths + Bash-command
   *  deny tiers). `false` ⇒ a run with an armed policy is REFUSED, never silently
   *  ungoverned (issue #296; real Codex-side enforcement is tracked as #304). */
  supportsHarnessPolicy: z.boolean(),
  /** Can write the per-task flight-recorder audit ledger (issue #296). Declared
   *  truthfully but NOT currently a refusal trigger — the ledger path is set
   *  unconditionally per project, not an "armed" signal; see
   *  `assertGovernanceInvariant`'s docblock. Exists for descriptor completeness
   *  and #304's real-enforcement follow-up. */
  supportsLedger: z.boolean(),
  /** MCP server configuration/inspection. */
  supportsMcp: z.boolean(),
  /** A dedicated plan/read-only mode. */
  supportsPlanMode: z.boolean(),
  /** Structured (schema-constrained) output; else a text-JSON parse fallback. */
  supportsStructuredOutput: z.boolean(),
  /** Resuming a prior session by id. */
  supportsSessionResume: z.boolean(),
  /** Provider-side file checkpointing / revert. */
  supportsFileCheckpointing: z.boolean(),
  /** Interactive AskUserQuestion prompts (else degrade to permission prompts). */
  supportsAskUserQuestion: z.boolean(),
  /** Layered setting sources (e.g. `~/.claude`). */
  supportsSettingSources: z.boolean(),
  /** A durable session store the history view can read. */
  supportsSessionStore: z.boolean(),
  /** A per-model reasoning-effort control. */
  supportsEffort: z.boolean(),
  /** Can enforce a per-run `maxTurns` conversation ceiling. `false` ⇒ the control
   *  is silently unenforced for this provider (issue #296): Codex's
   *  `@openai/codex-sdk` `TurnOptions` exposes only `outputSchema` + `signal`, so a
   *  turn ceiling can't be honored — declared false rather than silently ignored so
   *  the UI can caveat it. */
  supportsMaxTurns: z.boolean(),
  /** Can enforce a per-run `maxBudgetUsd` cost ceiling. `false` ⇒ silently
   *  unenforced for this provider (issue #296) — same `TurnOptions` limitation as
   *  {@link ProviderCapabilities.supportsMaxTurns}; declared truthfully so the UI
   *  can caveat it instead of a ceiling quietly not applying. */
  supportsMaxBudget: z.boolean(),
  /** How completely the provider reports run cost. */
  costTelemetry: CostTelemetrySchema,
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;
