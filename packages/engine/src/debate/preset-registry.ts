/**
 * The Council preset registry (issue #349) — the engine half of preset-as-data.
 *
 * `@nightcore/contracts` owns the `CouncilPresetId` enum (the shared cross-tier
 * vocabulary, force-emitted to Rust); this module owns the concrete preset VALUES,
 * exactly as `providers/claude/kind-presets.ts` owns the agent definition for each
 * `TaskKind`. A preset is looked up by its typed id via {@link resolveCouncilPreset}.
 *
 * The registry is a TOTAL map keyed by `CouncilPresetId`, so adding a preset id to
 * the contract enum forces a registry entry here — the type checker is the parity
 * guard. P1 ships exactly one preset: {@link RESEARCH_COUNCIL_PRESET}.
 *
 * The preset values here are DATA only; the P1 invariants (`≤4` seats, `≥2` distinct
 * models, positive caps) are enforced by `validateCouncilPreset` — see the tests,
 * which assert every registered preset validates.
 */
import type { CouncilPreset, CouncilPresetId } from '@nightcore/contracts';

/**
 * The P1 **Research** council: a governed debate that produces a synthesized
 * recommendation with cited tradeoffs for a human to accept.
 *
 * - **Seats** — two proposers on DISTINCT models (heterogeneity is the point) plus a
 *   critic; three seats, two distinct models, well under the `≤4` cap.
 * - **Stages** — `Frame → Propose(blind) → Debate(≤2) → Converge(human)`. Propose is
 *   blind (parallel, unaware of each other) so diversity survives into the debate;
 *   Debate loops at most twice; the human is the terminal judge.
 * - **Routing** — the conductor-`moderated-bus`, no peer edges (safety #1).
 * - **Budget** — hard caps the conductor's kill/early-stop enforces (safety #4).
 */
export const RESEARCH_COUNCIL_PRESET: CouncilPreset = {
  id: 'research',
  label: 'Research council',
  seats: [
    { id: 'proposer-opus', role: 'proposer', model: 'claude-opus-4-8' },
    { id: 'proposer-sonnet', role: 'proposer', model: 'claude-sonnet-4-6' },
    { id: 'critic-opus', role: 'critic', model: 'claude-opus-4-8' },
  ],
  stages: [
    { stage: 'frame', blind: false },
    { stage: 'propose', blind: true },
    { stage: 'debate', blind: false, maxRounds: 2 },
    { stage: 'converge', blind: false },
  ],
  routing: { mode: 'moderated-bus', edges: [] },
  successCriterion:
    'A synthesized recommendation with explicit, cited tradeoffs that the human judge accepts.',
  convergence: 'human',
  budget: { maxRounds: 2, maxTotalTokens: 400_000, maxCostUsd: 5 },
};

/** Every council preset, keyed by its id. Total over `CouncilPresetId`, so a new
 *  preset id fails to type-check until a value is registered here. */
export const COUNCIL_PRESETS: Readonly<Record<CouncilPresetId, CouncilPreset>> =
  Object.freeze({
    research: RESEARCH_COUNCIL_PRESET,
  });

/** Resolve a council preset by its typed id. Total: every `CouncilPresetId` has a
 *  registered preset (the type checker enforces it), so this never returns
 *  `undefined`. */
export function resolveCouncilPreset(id: CouncilPresetId): CouncilPreset {
  return COUNCIL_PRESETS[id];
}
