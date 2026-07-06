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
 * This module is CONTRACT-ONLY. It introduces the vocabulary (`ProviderId`,
 * `AutonomyLevel`, `ProviderCapabilities`); no consumer is wired to it yet, so it
 * changes no behavior. Because nothing on the NDJSON wire (`SurfaceCommand` /
 * `NightcoreEvent` / `SurfaceQuery`) references these shapes yet, the zod→Rust
 * codegen (`gen-rust-contracts.ts`) does not emit them into `generated.rs` at this
 * phase — the canonical Rust names are pre-registered in that emitter's
 * `ENUM_NAMES` so a later wiring phase emits them without a rename. See issue #18.
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
  /** How completely the provider reports run cost. */
  costTelemetry: CostTelemetrySchema,
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;
