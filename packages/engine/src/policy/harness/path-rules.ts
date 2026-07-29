/**
 * The repo-relative glob-matching engine shared by the harness policy gate
 * (`../harness-policy.ts` — protected-path + read-deny tiers) and the exec-sink
 * write-protection gate (`../exec-sink.ts`).
 *
 * THE IMPLEMENTATION MOVED (issue #400). The compile + segment-match core now
 * lives in `@nightcore/contracts` (`policy-patterns.ts`), colocated with the
 * `HarnessPolicySchema` that declares these semantics on the wire. The reason is
 * the authoring surface: the web policy editor's pattern tester must answer
 * "does this rule match this path?" with the SAME engine that enforces it, and a
 * surface may never import `@nightcore/engine` (it owns the Claude SDK). Rather
 * than let a second matcher drift into the UI — the exact failure the tester
 * exists to prevent — the one true matcher sits at contract rank and BOTH sides
 * consume it.
 *
 * This module stays as the engine-side import site so every gate keeps one home
 * for its glob semantics; the documentation of those semantics travels with the
 * implementation (see `policy-patterns.ts`).
 */
export {
  type CompiledPathRule,
  compilePathRule,
  pathSegments,
  ruleProtects,
} from '@nightcore/contracts';
