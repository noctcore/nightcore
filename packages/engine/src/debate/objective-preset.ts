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
 *  2. The DORMANT single-writer Build contract (documented below) — the write step that
 *     turns a RED repro GREEN. It is deliberately NOT implemented in this slice; see
 *     {@link BuildDriver} and the note below.
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
 * ── DORMANT: the write-capable Build driver is a tracked follow-up ──
 * The `build` stage runs ONLY when a {@link BuildDriver} is injected (see
 * `conductor-build.ts`'s double gate). Production injects NONE today, so a UI-bug council
 * debates a repro + fix plan but does not yet WRITE the fix (the repro stays RED and the
 * gate correctly refuses to auto-adopt over it). The real write-capable
 * `SessionBuildDriver` — one elected writer editing on an ISOLATED worktree at
 * {@link import('./build-writer.js').BUILD_WRITER_HARDENING} (write-capable + Seatbelt),
 * routing every tool call through the SAME confinement chokepoints a board task uses
 * (worktree `allocate`/`merge`/`remove`, the PreToolUse workspace-confinement gate,
 * `platform::git_command`, the `CommitLease` single-flight) with NO new exec sink —
 * requires an engine↔Rust worktree-allocation/merge seam that does not exist yet, so it is
 * its own security-critical slice (a tracked follow-up), NOT bolted onto this preset PR.
 * When it lands it is injected here (via `buildDriver`) and the injected gauntlet runner is
 * pointed at its worktree — the gate + writer activate together. #368 (Coding preset)
 * REUSES this module's resolver and, when it exists, that shared driver.
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
 *  - otherwise the `repro` reproduce-first gate, built on {@link gauntletObjectiveGate}
 *    (reusing the gauntlet exec — no new sink). A RED repro FAILS the gate and overrides
 *    consensus; a GREEN repro passes it (pending the human, who stays terminal — safety #7).
 *
 * The `objectiveGate` enum is exhaustive: every kind maps to a gate here, so adding a kind
 * fails to type-check until it is handled.
 */
export function objectiveGateForPreset(
  preset: CouncilPreset,
  runGauntlet: GauntletRunner | undefined,
): ObjectiveGate | undefined {
  if (preset.objectiveGate === undefined || runGauntlet === undefined) {
    return undefined;
  }
  switch (preset.objectiveGate) {
    case 'repro':
      // The reproduce-first repro gate: the repro check runs as a Structure-Lock gauntlet
      // over the build output. Reuse the gauntlet adapter — this module invents no exec.
      return gauntletObjectiveGate(runGauntlet);
  }
}
