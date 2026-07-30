import { z } from 'zod';

import { TaskKindSchema } from './config.js';
import { AutonomyLevelSchema, type ProviderCapabilities } from './provider.js';
import { WRITE_TOOL_NAMES } from './tools.js';

/**
 * `skill` — the {@link SkillDescriptorSchema} contract (issue #158, T17 stage 0–1:
 * the `TaskKind` → skill-registry keystone).
 *
 * ## What a skill is
 *
 * A skill is a GOVERNED AGENT RECIPE: the complete declaration of how one kind of
 * work is run and what it is allowed to do. Today the studio has exactly five,
 * they are hard-coded, and each one is authored in TWO HALVES by two different
 * tiers that deliberately never reach into each other:
 *
 *  - the AGENT DEFINITION (engine, `providers/claude/kind-presets.ts`) — the
 *    system-prompt append, the tool allow/deny policy, the default permission
 *    mode, whether structured output is requested;
 *  - the ORCHESTRATION POLICY (Rust core, `workflow/kind.rs`) — whether the run
 *    gets its own worktree, whether it enters the verification gate, whether it
 *    writes code at all.
 *
 * `TaskKind` is the only thing the two halves share. This module names the WHOLE:
 * one shape that carries both halves plus the identity and governance facts that
 * are currently spread across a third tier (the web's kind picker labels).
 *
 * ## Why the shape looks like this
 *
 * The north star (roadmap §7, skill-registry stages 2–3) is a user-defined skill
 * dropped into `.nightcore/skills/` that neither tier has ever heard of. That
 * fixes the shape: a descriptor must be a SELF-CONTAINED declaration — everything
 * both tiers would need to run a kind with no `match` arm and no preset entry —
 * not an id that points at code (the `CouncilPresetId` pattern, which
 * works only because the engine ships the preset VALUE). So this follows the
 * `ProviderCapabilities` pattern instead: a complete descriptor whose posture
 * fields are all REQUIRED, because an unstated governance fact must never be an
 * implicit `false`.
 *
 * The split into {@link SkillAgentDefinitionSchema} and
 * {@link SkillOrchestrationSchema} is not decoration — it is the tier boundary
 * made addressable, so each tier can produce or consume its own half without
 * acquiring an opinion about the other's. The engine derives its half from the
 * live presets (`describeSkillAgent`); nothing derives the orchestration half yet
 * (see "What this stage does NOT do").
 *
 * ## Honesty rules this schema follows
 *
 * A descriptor field must be something a tier can ACT on. Two consequences:
 *
 *  - Per-skill run ceilings (`maxTurns` / `maxBudgetUsd`) and a per-skill autonomy
 *    CEILING are deliberately NOT declared. They are real stage-3 requirements,
 *    but nothing reads a skill for them today (ceilings come from Settings and the
 *    start-session command), and a governance field that nothing enforces is worse
 *    than an absent one — it manufactures the same false confidence a silently-dead
 *    policy rule does. They are additive when an enforcement path exists.
 *  - `model` is absent by design: a skill is provider-neutral, and model choice is
 *    a run-level decision. (Council presets pin models per seat because a council's
 *    whole point is model DIVERSITY; a skill has no such requirement.)
 *
 * {@link diagnoseSkillDescriptor} then enforces the invariants a structural parse
 * cannot — chiefly that a skill claiming not to write code is actually denied the
 * write tools.
 *
 * ## Wire format
 *
 * UNCHANGED, and this module is not reachable from one. `SurfaceCommand` /
 * `NightcoreEvent` / `SurfaceQuery` carry none of these shapes, so the zod→Rust
 * emitter (`tools/codegen/gen-rust-contracts.ts`) does not emit them into
 * `generated.rs` — the same posture `provider.ts` documents for
 * `ProviderCapabilities`. What crosses the wire today is still the closed
 * `TaskKind` enum on `start-session`.
 *
 * ## What this stage does NOT do
 *
 * No tier authors a whole descriptor yet, and no builtin registry is assembled
 * here. That would require restating the Rust core's orchestration policy in TS,
 * which is a fourth authoring of a table whose `match` is currently the compiler's
 * exhaustiveness guard — the issue's own deferral. Stage 2 (opening the `Task.kind`
 * wire to a slug with quarantine-on-unknown) is where the registry becomes the
 * source of truth and the duplication is REMOVED rather than added to.
 */

/**
 * A skill's identifier.
 *
 * Today this IS {@link TaskKindSchema} — a closed enum — and that is the honest
 * declaration, not a placeholder: the wire only accepts these five values, so a
 * descriptor carrying any other id could not be dispatched. Aliasing rather than
 * re-declaring keeps the two vocabularies incapable of drifting while they are the
 * same set, and gives stage 2 (slug ids + quarantine-on-unknown) exactly ONE place
 * to widen.
 */
export const SkillIdSchema = TaskKindSchema;
export type SkillId = z.infer<typeof SkillIdSchema>;

/**
 * Where a skill came from — the trust boundary.
 *
 * `builtin` is the only value today and is deliberately declared as a one-value
 * enum (the one-value `CouncilRoutingMode` precedent) rather than assumed: a
 * project/user-authored skill is UNTRUSTED input and will need to be governed
 * differently from one that shipped in the binary, so the field that distinguishes
 * them should exist before the first one arrives — not be retrofitted around it.
 */
export const SkillSourceSchema = z.enum(['builtin']);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

/** The boolean-valued keys of {@link ProviderCapabilities} — the capability FLAGS,
 *  excluding its non-flag descriptor fields (`id`, `label`, `autonomyLevels`,
 *  `costTelemetry`). `satisfies` makes a name that is not a flag a COMPILE error;
 *  the reverse direction (a newly-added flag missing from this list) is pinned by
 *  the parity test in `skill.test.ts`, which reads the keys off
 *  `ProviderCapabilitiesSchema.shape`. */
type ProviderCapabilityFlagName = {
  [K in keyof ProviderCapabilities]: ProviderCapabilities[K] extends boolean
    ? K
    : never;
}[keyof ProviderCapabilities];

const PROVIDER_CAPABILITY_FLAGS = [
  'supportsHooks',
  'providesOwnWriteContainment',
  'supportsHarnessPolicy',
  'supportsLedger',
  'supportsMcp',
  'supportsPlanMode',
  'supportsStructuredOutput',
  'supportsSessionResume',
  'supportsFileCheckpointing',
  'supportsAskUserQuestion',
  'supportsSettingSources',
  'supportsSessionStore',
  'supportsEffort',
  'supportsMaxTurns',
  'supportsMaxBudget',
] as const satisfies readonly ProviderCapabilityFlagName[];

/**
 * One provider capability a skill can REQUIRE to be enforceable.
 *
 * This is the seam the roadmap's "capability-aware enforcement requirements" needs
 * (stage 3: a skill's tool policy must refuse or degrade on a hook-less provider).
 * It names a flag rather than restating a boolean so the requirement is checked
 * against the provider's own descriptor — the same graceful-degradation posture the
 * rest of the app follows, where behavior flows from the capability descriptor and
 * never from a `match provider` branch.
 */
export const ProviderCapabilityFlagSchema = z.enum(PROVIDER_CAPABILITY_FLAGS);
export type ProviderCapabilityFlag = z.infer<
  typeof ProviderCapabilityFlagSchema
>;

/**
 * A skill's tool policy: names to explicitly allow, and names to deny.
 *
 * Both lists are declared even though today's builtins only populate `deny`,
 * because the two are not symmetric and a descriptor must be able to say which it
 * means. An empty `allow` is "inherit the session's toolset", NOT "allow nothing" —
 * the denial is what is load-bearing (the SDK honors `disallowedTools` regardless
 * of permission mode, which is why every write-capable kind can deny network egress
 * even while running under bypass).
 */
export const SkillToolPolicySchema = z.object({
  /** Tools to explicitly allow. Empty ⇒ inherit the session's toolset. */
  allow: z.array(z.string()).default([]),
  /** Tools this skill may never call. Enforced by the provider, not advisory. */
  deny: z.array(z.string()).default([]),
});
export type SkillToolPolicy = z.infer<typeof SkillToolPolicySchema>;

/**
 * The AGENT-DEFINITION half of a skill — the half the engine owns (Claude:
 * `providers/claude/kind-presets.ts`).
 *
 * Stated in provider-NEUTRAL vocabulary: `defaultAutonomy` is the shared
 * {@link AutonomyLevelSchema} ceiling rather than a Claude SDK permission mode, and
 * `structuredOutput` is a boolean request rather than a provider-specific output
 * schema. Both choices exist so a descriptor stays meaningful under a provider that
 * has neither vocabulary — the engine lowers the neutral value at its own boundary,
 * which is where the Claude-only modes (`dontAsk`, `auto`) already collapse.
 */
export const SkillAgentDefinitionSchema = z.object({
  /** Appended to the session's system prompt — the skill's persona. Empty ⇒ none. */
  systemPromptAppend: z.string().default(''),
  /** The tools this skill may and may not call. Absent ⇒ no restrictions declared
   *  (the `research` posture), which is a real answer, not a missing one. */
  toolPolicy: SkillToolPolicySchema.default({ allow: [], deny: [] }),
  /** The autonomy ceiling this skill defaults to, in the neutral vocabulary.
   *  `null` ⇒ inherit (the session's explicit choice, then the provider default).
   *  Required — even "inherit" must be stated. An explicit value is a DEFAULT, not a
   *  ceiling: a run-level choice still wins over it. */
  defaultAutonomy: AutonomyLevelSchema.nullable(),
  /** Whether the skill asks the provider for schema-constrained output instead of
   *  free text. `true` requires `supportsStructuredOutput` — a provider without it
   *  falls back to parsing prose, which is exactly how a decompose run once failed
   *  silently, so the requirement must be DECLARED (see
   *  {@link diagnoseSkillDescriptor}), not assumed. */
  structuredOutput: z.boolean(),
});
export type SkillAgentDefinition = z.infer<typeof SkillAgentDefinitionSchema>;

/**
 * The ORCHESTRATION half of a skill — the half the Rust core owns
 * (`workflow/kind.rs`). Every field is REQUIRED: these are the governance facts a
 * run is scheduled from, and an unstated one must never default to `false`.
 */
export const SkillOrchestrationSchema = z.object({
  /** Whether a run of this skill gets its own isolated git worktree. */
  allocatesWorktree: z.boolean(),
  /** Whether a completed run enters the verification gate (reviewer + gauntlet)
   *  instead of going straight to done. */
  verifyAfter: z.boolean(),
  /** Whether this skill's agent is expected to modify the workspace. The claim
   *  {@link diagnoseSkillDescriptor} holds the tool policy to. */
  writesCode: z.boolean(),
});
export type SkillOrchestration = z.infer<typeof SkillOrchestrationSchema>;

/**
 * One skill — the whole governed recipe: identity, both tier halves, and the
 * provider capabilities it needs to be enforceable.
 *
 * The invariants a skill must satisfy to be COHERENT (a read-only skill is denied
 * the write tools; a verified skill actually writes something) are not baked into
 * this structural schema — they are reported by {@link diagnoseSkillDescriptor} as
 * surfaceable diagnostics, following the same split the council preset uses:
 * `parse` owns structure, a typed validator owns meaning, and neither throws at an
 * author who is mid-edit.
 */
export const SkillDescriptorSchema = z.object({
  /** The skill's id — a `TaskKind` today; see {@link SkillIdSchema}. */
  id: SkillIdSchema,
  /** Human-readable name for the picker (`Build`, `TDD`, …). */
  label: z.string(),
  /** One line describing the affordance — what selecting this skill will do. */
  summary: z.string(),
  /** Builtin vs (eventually) user-authored — the trust boundary. */
  source: SkillSourceSchema,
  /** Whether a user may create a task AS this skill. `false` marks an
   *  internally-dispatched identity: `review` is the verification reviewer the gate
   *  spins up, never a kind a user picks. A registry without this field would leak
   *  internal identities into the picker the moment it drove one. */
  userSelectable: z.boolean(),
  /** The engine-owned half. */
  agent: SkillAgentDefinitionSchema,
  /** The core-owned half. */
  orchestration: SkillOrchestrationSchema,
  /** Provider capability flags that must be TRUE for this skill to run as declared.
   *  Empty ⇒ the skill degrades acceptably anywhere. */
  requiredCapabilities: z.array(ProviderCapabilityFlagSchema).default([]),
});
export type SkillDescriptor = z.infer<typeof SkillDescriptorSchema>;

/** Why a descriptor is incoherent. Codes are stable so a surface can key off them
 *  rather than matching message text. */
export type SkillDescriptorIssueCode =
  | 'read-only-permits-writes'
  | 'verify-without-writes'
  | 'writes-without-worktree'
  | 'contradictory-tool-policy'
  | 'undeclared-structured-output';

/**
 * How badly wrong a descriptor is — the same severity contract `policy-lint` uses,
 * so an editor can apply one rule to both:
 *  - `error`   ⇒ the descriptor is PROVABLY incoherent. It claims something its own
 *                fields contradict; running it would enforce less than it says.
 *  - `warning` ⇒ coherent but a known foot-gun; the author may know something this
 *                check does not, so it must never block authoring.
 */
export type SkillDescriptorSeverity = 'error' | 'warning';

/** One diagnostic about one skill descriptor. `message` names the consequence, so
 *  it can be shown verbatim next to the field it is about. */
export interface SkillDescriptorDiagnostic {
  code: SkillDescriptorIssueCode;
  severity: SkillDescriptorSeverity;
  message: string;
}

/**
 * Check a descriptor for claims its own fields contradict. Pure; returns every
 * issue it finds (never throws, never short-circuits) so an author sees the whole
 * list at once.
 *
 * The load-bearing one is `read-only-permits-writes`: `writesCode: false` is what
 * the orchestrator schedules on (no worktree, no verification gate) and what the UI
 * tells the user, so a skill making that claim while its tool policy leaves
 * {@link WRITE_TOOL_NAMES} callable is a governance LIE — it would mutate the
 * user's checkout from a run nothing is watching. Every read-only builtin
 * (`review`, `decompose`) already denies exactly that set; this makes the
 * requirement checkable for a skill that did not ship in the binary.
 */
export function diagnoseSkillDescriptor(
  skill: SkillDescriptor,
): SkillDescriptorDiagnostic[] {
  const diagnostics: SkillDescriptorDiagnostic[] = [];
  const { agent, orchestration } = skill;
  const denied = new Set(agent.toolPolicy.deny);

  if (!orchestration.writesCode) {
    const permitted = WRITE_TOOL_NAMES.filter((tool) => !denied.has(tool));
    if (permitted.length > 0) {
      diagnostics.push({
        code: 'read-only-permits-writes',
        severity: 'error',
        message:
          `declares \`writesCode: false\` but does not deny ${permitted.join(', ')} — ` +
          'a read-only skill must be unable to write, not merely expected not to.',
      });
    }
  }

  if (orchestration.verifyAfter && !orchestration.writesCode) {
    diagnostics.push({
      code: 'verify-without-writes',
      severity: 'error',
      message:
        'declares `verifyAfter: true` but `writesCode: false` — the verification gate ' +
        'reviews the diff a run produced, so there would be nothing to verify.',
    });
  }

  if (orchestration.writesCode && !orchestration.allocatesWorktree) {
    diagnostics.push({
      code: 'writes-without-worktree',
      severity: 'warning',
      message:
        'writes code without its own worktree — the run edits the checked-out branch ' +
        'directly, so its changes are not isolated from concurrent runs.',
    });
  }

  const contradictory = agent.toolPolicy.allow.filter((tool) => denied.has(tool));
  if (contradictory.length > 0) {
    diagnostics.push({
      code: 'contradictory-tool-policy',
      severity: 'error',
      message:
        `allows and denies the same tools (${contradictory.join(', ')}) — denial wins, ` +
        'so the allow entries are dead and the policy does not read as it behaves.',
    });
  }

  if (
    agent.structuredOutput &&
    !skill.requiredCapabilities.includes('supportsStructuredOutput')
  ) {
    diagnostics.push({
      code: 'undeclared-structured-output',
      severity: 'error',
      message:
        'requests structured output without requiring `supportsStructuredOutput` — on a ' +
        'provider that lacks it the result silently degrades to parsed prose instead of ' +
        'refusing.',
    });
  }

  return diagnostics;
}
