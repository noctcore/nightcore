import { z } from 'zod';

import { DebateSeatRoleSchema, DebateStageSchema } from './debate.js';

/**
 * Council preset-as-data (issue #349 — the P1 slice).
 *
 * A council configuration is DATA, not code: `{roles, models, stages, routing,
 * success_criterion, convergence, budget}`. It is modeled on the existing
 * `TaskKind` → skill-registry pattern (`config.ts` `TaskKindSchema` +
 * `providers/claude/kind-presets.ts`): the {@link CouncilPresetIdSchema} enum is the
 * ONE thing the Rust core and the engine share — the core will own each preset's
 * ORCHESTRATION policy (the Conductor, a downstream slice), the engine owns the
 * concrete preset VALUE (`packages/engine/src/debate/preset-registry.ts`). Snake/
 * kebab is avoided: the id rides the wire lowercase, matching the Rust
 * `CouncilPresetId` serde mapping the zod→Rust codegen force-emits.
 *
 * The vocabulary here REUSES the merged debate foundation (`debate.ts`): a seat's
 * asymmetric {@link DebateSeatRoleSchema} role and the state-machine
 * {@link DebateStageSchema} stage are the same enums the transcript entry carries,
 * so a preset and a run cannot diverge on what a role or a stage means.
 *
 * P1 ships one preset (`research`) whose stage sequence is
 * `Frame → Propose(blind) → Debate(≤2) → Converge(human)`. The schema is kept open
 * enough to grow (more preset ids; `judge-agent`/`vote` convergence; editable routing
 * edges) without a breaking change, but P1 only exercises the human-judged, blind-
 * propose, moderated-bus subset.
 */

/**
 * The id of a council preset — the shared cross-tier vocabulary (mirrors
 * `TaskKind`). P1 ships exactly one: `research`. Adding a preset id touches this
 * enum, the Rust `CouncilPresetId` (force-emitted by `gen-rust-contracts.ts`), and
 * `ENUM_NAMES` — the same three-site house rule `TaskKind` follows.
 */
export const CouncilPresetIdSchema = z.enum(['research']);
export type CouncilPresetId = z.infer<typeof CouncilPresetIdSchema>;

/**
 * How a council's Converge stage reaches a decision.
 *
 *  - `human` — the human judge is the sole terminal authority (safety non-negotiable
 *    #7). The Conductor parks the seats' final positions for a human `accept`/`reject`/
 *    `judge` gavel. This is the P1 mode.
 *  - `judge-agent` — a DEDICATED judge seat (asymmetric `judge` role, excluded from the
 *    debate) rules on the debating seats' positions (issue #370, P2). Its ruling is an
 *    UNTRUSTED seat output: injection-scanned + mediated + delivered quoted, exactly like
 *    any other seat's text (safety #1/#2). It cannot bypass the objective gate (safety
 *    #6) or the human (safety #7): a red gate refuses its adoption and parks for the
 *    human, who alone can override the gate.
 *  - `vote` — the debating seats vote on the positions and a quorum (strict majority)
 *    resolves the winner (issue #370, P2). Each vote is untrusted, scanned data too, and
 *    the same gate/human overrides apply.
 *
 * A non-human mode still AUTO-CLOSES the run only when it cleanly adopts a position over
 * a green/absent objective gate; on a red gate, a reject, or no quorum it records its
 * finding onto the append-only transcript (via the Conductor, never a direct store write)
 * and parks for the human. The convergence value is engine-internal preset data — it is
 * NOT part of the cross-tier `CouncilPresetId` vocabulary, so it never crosses to Rust.
 */
export const CouncilConvergenceSchema = z.enum(['human', 'judge-agent', 'vote']);
export type CouncilConvergence = z.infer<typeof CouncilConvergenceSchema>;

/**
 * The bus routing mode. P1 is the conductor-`moderated-bus` ONLY: seats have zero
 * agent-to-agent command authority, which is the injection firewall (safety
 * non-negotiable #1). Peer-to-peer modes are intentionally NOT declared yet — they
 * would weaken that firewall and belong to a later, deliberately-gated slice.
 */
export const CouncilRoutingModeSchema = z.enum(['moderated-bus']);
export type CouncilRoutingMode = z.infer<typeof CouncilRoutingModeSchema>;

/**
 * A directed routing edge ("A informs B") — the data behind an editable canvas
 * edge. P1 ships none (the moderated bus reaches every seat), but the shape exists
 * so the P2 editable-edges slice is additive.
 */
export const CouncilRoutingEdgeSchema = z.object({
  /** The seat id the information flows FROM. */
  from: z.string(),
  /** The seat id the information flows TO. */
  to: z.string(),
});
export type CouncilRoutingEdge = z.infer<typeof CouncilRoutingEdgeSchema>;

/** The council's routing policy: the mode plus any explicit directed edges. */
export const CouncilRoutingSchema = z.object({
  mode: CouncilRoutingModeSchema,
  /** Explicit "A informs B" edges. Empty under `moderated-bus` (the P1 default). */
  edges: z.array(CouncilRoutingEdgeSchema).default([]),
});
export type CouncilRouting = z.infer<typeof CouncilRoutingSchema>;

/**
 * One council seat. This is the design's `roles` × `models` carried as PAIRS rather
 * than two index-coupled parallel arrays, so a seat's asymmetric role and its model
 * can never drift out of alignment. A seat is a DEBATING participant (proposer /
 * critic); the human judge is NOT a seat — it is expressed by
 * `convergence: 'human'`.
 */
export const CouncilSeatSchema = z.object({
  /** Stable per-preset seat id (referenced by routing edges and the transcript). */
  id: z.string(),
  /** The seat's asymmetric role — the SAME vocabulary the transcript entry uses. */
  role: DebateSeatRoleSchema,
  /** The provider model id driving this seat (a free string at the SDK boundary,
   *  matching how `model` rides the wire elsewhere). Distinctness across seats is
   *  what the diversity guard enforces. */
  model: z.string(),
});
export type CouncilSeat = z.infer<typeof CouncilSeatSchema>;

/**
 * One step of the council state machine. `blind` marks a stage whose seats act in
 * parallel WITHOUT seeing each other (Propose is blind — it preserves diversity
 * before debate collapses it). `maxRounds` bounds a looping stage (Debate is
 * `≤2`); absent for non-looping stages.
 */
export const CouncilStageStepSchema = z.object({
  /** The state-machine stage — the SAME vocabulary the transcript entry uses. */
  stage: DebateStageSchema,
  /** Whether seats act blind (in parallel, unaware of each other) in this stage. */
  blind: z.boolean().default(false),
  /** The per-stage round cap for a looping stage (Debate). Absent = single pass. */
  maxRounds: z.number().int().positive().optional(),
});
export type CouncilStageStep = z.infer<typeof CouncilStageStepSchema>;

/**
 * The council's HARD budget/round caps (safety non-negotiable #4: hard caps + a
 * kill switch — never "run until they agree"). Every cap is required and must be
 * positive; the conductor's kill/early-stop reads these. The zod schema pins
 * positivity for parsed input; the engine's `validateCouncilPreset` re-checks it so
 * a preset hand-built in TS (bypassing `parse`) is still rejected.
 */
export const CouncilBudgetSchema = z.object({
  /** Absolute cap on debate rounds across the whole run. */
  maxRounds: z.number().int().positive(),
  /** Absolute cap on total tokens across all seats. */
  maxTotalTokens: z.number().int().positive(),
  /** Absolute cap on total spend, in USD. */
  maxCostUsd: z.number().positive(),
});
export type CouncilBudget = z.infer<typeof CouncilBudgetSchema>;

/**
 * A whole council preset — the data a run is configured from. The invariants the
 * design requires (`≤4` seats, `≥2` DISTINCT models, present+positive caps) are
 * NOT baked into this structural schema: they are enforced by the engine's typed
 * `validateCouncilPreset`, which returns a surfaceable error rather than throwing
 * on `parse`.
 */
export const CouncilPresetSchema = z.object({
  /** The preset's cross-tier id. */
  id: CouncilPresetIdSchema,
  /** A human-readable label for the picker. */
  label: z.string(),
  /** The debating seats (the design's `roles` × `models`). */
  seats: z.array(CouncilSeatSchema),
  /** The ordered stage sequence (`Frame → Propose → Debate → Converge` for P1). */
  stages: z.array(CouncilStageStepSchema),
  /** The bus routing policy. */
  routing: CouncilRoutingSchema,
  /** What "done" means for this council — the success criterion the judge weighs. */
  successCriterion: z.string(),
  /** How the Converge stage decides (`human` for P1). */
  convergence: CouncilConvergenceSchema,
  /** The hard budget/round caps. */
  budget: CouncilBudgetSchema,
});
export type CouncilPreset = z.infer<typeof CouncilPresetSchema>;
