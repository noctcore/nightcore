/**
 * OBJECTIVE-PRESET machinery (issue #367, P2) — the SHARED surface a build-capable,
 * objective-task council reuses. Both the reproduce-first UI-bug preset (#367) and the
 * Coding preset (#368) are objective presets: their Converge runs a DETERMINISTIC gate
 * whose RED verdict OVERRIDES debate consensus (safety non-negotiable #6). This module
 * owns the two things those presets share:
 *
 *  1. {@link objectiveGateForPreset} — the preset-aware gate RESOLVER. Given a preset and
 *     an injected gauntlet runner, it builds the concrete {@link ObjectiveGate} the run's
 *     Converge should use, or `undefined` for a pure-reasoning preset (so `research` stays
 *     gate-less). This is the injection point the Conductor calls per run — the gate is
 *     DATA-DRIVEN off the preset's `objectiveGate` marker, so a new objective preset needs
 *     no new wiring.
 *  2. The single-writer Build contract (documented below) — the write step that turns a RED
 *     repro GREEN. Its real, write-capable driver shipped in #383/#386; see {@link
 *     BuildDriver} and the note below for how this resolver + that driver activate together.
 *
 * ── The reproduce-first gate is REAL and REUSES the gauntlet, no new exec sink ──
 * The `repro` gate is a Structure-Lock gauntlet check: {@link objectiveGateForPreset}
 * builds it via {@link gauntletObjectiveGate}, which maps a gauntlet result to a verdict.
 * The gauntlet's OWN exec (the harness `runChecks` bound to the run's worktree) is the only
 * exec — this module never spawns. In production the runner is injected pointing at the
 * writer's isolated worktree; in tests it is a deterministic fake. The reproduce-first
 * contract — the council establishes a RED repro FIRST, the Build turns it GREEN — is
 * expressed by the preset's stage sequence (`… → build → converge`) and enforced by
 * `validateCouncilPreset`; this gate is the terminal green check over the build output.
 *
 * ── The write-capable Build driver is LIVE (issue #383, shipped #386) ──
 * The `build` stage runs ONLY when a {@link BuildDriver} is injected (see
 * `conductor-build.ts`'s double gate). Production NOW injects the real write-capable
 * `SessionBuildDriver` (`session-build-driver.ts`, wired at `council-router.ts`) — one
 * elected writer editing on an ISOLATED worktree at
 * {@link import('./build-writer.js').BUILD_WRITER_HARDENING} (write-capable + Seatbelt),
 * routing every tool call through the SAME confinement chokepoints a board task uses
 * (worktree `allocate`/`commit`/`merge`/`remove`, the PreToolUse workspace-confinement gate,
 * `platform::git_command`, the `CommitLease` single-flight) with NO new exec sink. It reaches
 * `crate::worktree` over the path-less, `councilRunId`-keyed engine↔Rust seam (the host
 * DERIVES every path from the run id — the engine never sends one). The driver + the injected
 * gauntlet runner activate TOGETHER: the runner is pointed at the writer's worktree so the
 * terminal gate judges the BUILD OUTPUT, and a RED verdict overrides consensus (safety #6).
 * Merge/discard stay HUMAN-only (the council parks at Converge). A build-capable preset
 * (ui-bug #367, coding #368) activates both; `research` declares no `build` stage /
 * `objectiveGate`, so it stays gate-less + write-less on the same wiring.
 */
import type { CouncilPreset } from '@nightcore/contracts';

import {
  gauntletObjectiveGate,
  type GauntletRunner,
  type ObjectiveGate,
} from './objective-gate.js';

/** Whether a preset is an OBJECTIVE task — its Converge runs a deterministic terminal gate
 *  (safety #6) rather than parking for the human alone. `research` is not; the UI-bug
 *  preset (#367) is. */
export function isObjectivePreset(preset: CouncilPreset): boolean {
  return preset.objectiveGate !== undefined;
}

/**
 * Resolve the concrete {@link ObjectiveGate} a run should use at Converge, DATA-DRIVEN off
 * the preset's `objectiveGate` marker (issue #367). Returns:
 *
 *  - `undefined` for a pure-reasoning preset (no `objectiveGate`) — so `research` keeps its
 *    P1 human-only Converge, never a gate.
 *  - `undefined` when no gauntlet runner is injected — the gate's exec is the gauntlet's;
 *    with no runner there is nothing to run, so the run degrades to human-only (the DORMANT
 *    production state until the writer + its worktree land).
 *  - otherwise a gauntlet-backed gate, built on {@link gauntletObjectiveGate} (reusing the
 *    gauntlet exec — no new sink): the `repro` reproduce-first gate (#367) or the Coding
 *    preset's `build` build/test gate (#368). A RED gauntlet FAILS the gate and overrides
 *    consensus; a GREEN one passes it (pending the human, who stays terminal — safety #7).
 *
 * The `objectiveGate` enum is exhaustive: every kind maps to a gate here, and the switch ends
 * in `default: assertNever(kind)` (issue #385) so adding a kind without a resolver is a
 * COMPILE error, never a silent `undefined` (which would fail-OPEN — no terminal gate).
 */
export function objectiveGateForPreset(
  preset: CouncilPreset,
  runGauntlet: GauntletRunner | undefined,
): ObjectiveGate | undefined {
  if (preset.objectiveGate === undefined || runGauntlet === undefined) {
    return undefined;
  }
  const kind = preset.objectiveGate;
  switch (kind) {
    case 'repro':
      // The reproduce-first repro gate: the repro check runs as a Structure-Lock gauntlet
      // over the build output. Reuse the gauntlet adapter — this module invents no exec.
      return gauntletObjectiveGate(runGauntlet);
    case 'build':
      // The Coding preset's build/test gate (#368): a typecheck/lint/test gauntlet runs
      // over the writer's worktree — the SAME gauntlet adapter, no new exec sink. The
      // council debates the PLAN; this gate judges whether the built plan compiles + passes.
      return gauntletObjectiveGate(runGauntlet);
    default:
      // A new `CouncilObjectiveGate` kind added without a resolver here is a COMPILE error
      // (`kind` narrows to `never`), not a silent `undefined` return. That matters: an absent
      // objective gate = the terminal deterministic judge never runs, i.e. fail-OPEN on
      // safety non-negotiable #6. `strict` alone would let the unhandled kind fall through and
      // return `undefined` (no `noImplicitReturns`), so this guard is what keeps it fail-CLOSED
      // — adding a gate kind is forced to add its resolver (issue #385).
      return assertNever(kind);
  }
}

/** Exhaustiveness guard: reachable only if a `CouncilObjectiveGate` kind gains no resolver
 *  in the switch above. The `never` parameter makes that a compile error; the throw is the
 *  fail-CLOSED runtime backstop should an un-typed value ever reach it. */
function assertNever(kind: never): never {
  throw new Error(`unhandled council objective-gate kind: ${JSON.stringify(kind)}`);
}
