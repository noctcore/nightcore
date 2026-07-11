# Spec: T15 — Drift v1 (check-compiler + EnforceRun)

**Date:** 2026-07-11
**Status:** decided (grilled 2026-07-11) — build spec for the v0.3 slice
**Ticket:** #156 (T15). **Builds on:** T7 (#148/#184, armed-checks runtime), ENFORCE-lite
(`harness-enforce.ts` rule coverage). **Roadmap:** `docs/research/2026-07-11-roadmap-v0.3-v0.5.md` §10.

## Problem / why

The Enforce stage today ships **coverage, not conformance**: `RuleCoverageGap{status:
enforced | documented-only | unenforced}` tells you whether *a rule exists* for a
convention — never whether the convention is actually **followed** at every site.
That deeper "is convention X honored at all N sites" check is the moat's named missing
capability. The pure-LLM variant was killed on cost ($30–95/run — re-reading every
site). Drift v1 is the **hybrid**: an LLM compiles a convention into a *checkable*
artifact **once**, and a **deterministic** leg executes it repo-wide to count sites.

## Locked decisions (grill, 2026-07-11)

1. **Container — extend the Enforce surface; NO new scan family.** `ConventionDrift`
   rides the existing harness store additively (exactly as `coverage` was added to
   `HarnessScanCompletedEvent`). EnforceRun extends the existing `run_armed_checks_now`.
   Drift renders in/beside the existing `RuleCoverageGaps` panel. A first-class
   EnforceRun *run-record* + History row is a v0.4 upgrade, not v1.
2. **Substrate — the repo's own toolchain; NO new bundled binary.** The compiler emits
   checks in the idiom `RepoProfile` already detects. **v0.3 ships lint-meta rules +
   shell/ripgrep `--count` checks only.** ESLint-rule generation is a fast-follow gated
   on #185's RuleTester runner. ast-grep is v0.4.
3. **Compiler trigger — extend the synthesis pass (automatic).** Synthesis already emits
   arm-suggestions (`HarnessCheck`); make them concrete + convention-linked. No new run,
   no new pass, no new trigger. Every compiled check is still **human-gated at arm**.
4. **Drift gate — armed-only.** EnforceRun measures drift ONLY for checks a human has
   armed. No model-generated check (shell OR a generated lint-meta rule — both are code a
   runner executes) runs before a human reviewed + armed it. Pre-arm "preview drift" is a
   deliberate T16 native-sandbox feature, not v1.
5. **v0.3 reach — lint-meta + shell first** (see decision 2).

## Non-negotiable product rule

**Never render "followed" / "clean" without `method` + site counts.** A convention with
no armed check is `uncheckable` (honest), not "clean." A check whose output can't be
parsed into counts is `errored`, not "clean." Fail-visible, always.

## The loop (end to end)

```
Harness scan (Enforce stage)
   └─ synthesis pass
        ├─ (existing) ConventionFinding → ProposedArtifact + HarnessProposal
        └─ (NEW, slice 1) for each mechanically-checkable `kind:'convention'` finding
              above a confidence bar → compile an ARMABLE CHECK
                 · a lint-meta rule (structural/path conventions), OR
                 · a shell/ripgrep --count check (textual conventions)
              carrying the convention's `conventionFingerprint`.
   →  user reviews the check body + rationale, ARMS it (human gate, unchanged)
        → check lands in `.nightcore/harness.json` with its `conventionFingerprint`
   →  EnforceRun  (slice 2 — extends `run_armed_checks_now`)
        · runs the armed checks against the project root
        · parses each check's output into per-site violations  (slice 3 gives lint-meta a
          machine-readable reporter; shell checks use `--count` / matched-line count)
        · joins violations back to conventions by `conventionFingerprint`
        · emits ConventionDrift{status, method, sitesMatched, sitesChecked}
   →  Enforce UI (slice 4) renders drift per-convention on the coverage panel.
```

## Contracts (all additive — zero migration)

Extend `packages/contracts/src/harness-enforce.ts`:

```ts
// The measured conformance of a convention, from executing its armed check.
// Keyed on `conventionFingerprint` — the SAME key ENFORCE-lite's RuleCoverageGap
// reserved (its header explicitly says "a ConventionDrift record (Phase 2) will key
// on the same fingerprint"), so coverage + drift join with no migration.
export const ConventionDriftStatusSchema = z.enum([
  'clean',        // armed check ran, 0 violating sites (render WITH method + counts)
  'drifted',      // armed check ran, N>0 sites violate
  'uncheckable',  // no armed check covers this convention (honest — NOT "clean")
  'errored',      // the check could not run / its output could not be parsed
]);

export const ConventionDriftSchema = z.object({
  id: z.string(),                       // `drift-<conventionFingerprint>`
  conventionFingerprint: z.string(),    // join key
  category: z.string(),                 // ConventionCategory wire string (web casts)
  title: z.string(),                    // convention restated as the checked rule
  status: ConventionDriftStatusSchema,
  method: z.string(),                   // ALWAYS rendered: the check name + tool/rule id
                                        // that determined this (e.g. "lint-meta: folder-per-component"
                                        // or "shell: rg -c 'export default'")
  sitesMatched: z.number().default(0),  // violating sites
  sitesChecked: z.number().default(0),  // sites the check examined (0 ⇒ counts unknown → not "clean")
  checkName: z.string().optional(),     // the armed check that produced this
  errorReason: z.string().optional(),   // populated for `errored`
  fingerprint: z.string(),              // == conventionFingerprint (carry-forward key, v0.4)
});
```

`RuleCoverageGap` is unchanged; drift is a **separate additive record** joined to it in
the UI by `conventionFingerprint` (coverage answers "is there a rule?", drift answers
"is it followed?").

Extend the armed-check manifest so a compiled check remembers its origin convention:

- **zod** (`packages/contracts/src/harness.ts`, `HarnessCheckSchema`): add
  `conventionFingerprint: z.string().optional()`.
- **Rust** (`apps/desktop/src-tauri/src/store/harness_manifest.rs`, `ArmedCheckFile`): add
  the matching `Option<String>` field (serde-additive, defaults `None` — old manifests load).

Ride the completed event additively if the compiler wants to surface the newly-compiled
checks up front (optional — the arm-suggestion path via `HarnessCheck` already carries them).

## Persistence

Drift is the output of an EnforceRun. v0.3 persists it exactly where the last armed-checks
run already lives — extend `apps/desktop/src-tauri/src/store/checks_state.rs`'s last-run
record with an additive `drift: Vec<ConventionDrift>` (serde default empty; old records load).
No new store, no History wiring (that's the v0.4 first-class run-record).

## Build slices (v0.3)

Each slice is one PR, dependency-ordered. Slices 1 + 3 are collision-safe against the
in-flight #185/T9 wave and launch first; 2 waits on #185 items 2+3 (shared
`gauntlet_project`/checks surface); 4 is last.

### Slice 1 — Contract + synthesis compiler  (engine + contracts)  ·  independent-ish
- Add `ConventionDriftSchema` + `ConventionDriftStatusSchema` to `harness-enforce.ts`;
  add `conventionFingerprint` to `HarnessCheckSchema` (zod) and `ArmedCheckFile` (Rust).
  Regenerate BOTH codegen directions (zod→Rust `generated.rs`; Rust→TS via `cargo test`).
- Extend the Harness synthesis pass (`packages/engine/src/scans/harness/*` — locate the
  finalize/synthesis that emits `proposals`/`HarnessCheck`) so that for each
  `kind:'convention'` finding the model rates **mechanically checkable** and above a
  confidence bar, it emits a compiled check:
    · **lint-meta** for structural/path/naming conventions (preferred where the target
      repo `hasLintMeta`, or a portable Nightcore-shipped lint-meta rule form);
    · **shell/ripgrep `--count`** for textual conventions (portable fallback).
  The compiled check MUST carry the convention's `conventionFingerprint` on its
  `HarnessCheck`. Prompt the model to ONLY compile conventions expressible as a
  deterministic check; skip the rest (they stay `uncheckable`).
- The check body is a `ProposedArtifact` written via the **existing hardened apply path**
  (no denylist change) + a `HarnessCheck` arm-suggestion. **Never auto-arm.**
- Tests: synthesis emits a compiled lint-meta check + a shell check for fixture
  conventions, each carrying the right fingerprint; a non-checkable convention emits no
  check.
- **Note (merge):** touches contracts → will regenerate `generated.rs`, which the in-flight
  #185-item-1 agent may also touch. Expect a generated-file conflict on second merge;
  resolve by re-running the zod→Rust codegen (do NOT hand-edit generated files).

### Slice 2 — EnforceRun + site-count + fingerprint join  (Rust desktop)  ·  HOLD for #185 items 2+3
- Extend `run_armed_checks_now` (`apps/desktop/src-tauri/src/commands/checks.rs`) and/or the
  `workflow::gauntlet_project` runner so a full armed run additionally captures **structured
  per-check violations** (not just exit code): for lint-meta, parse the slice-3 reporter; for
  shell `--count` checks, the matched count is `sitesMatched` and the check declares
  `sitesChecked` (or it stays 0 → status can't be `clean`).
- Build `ConventionDrift[]` by joining each armed check's `conventionFingerprint` to its
  violation counts. Status mapping: 0 matched & sitesChecked>0 → `clean`; matched>0 →
  `drifted`; check ran but output unparseable / errored → `errored`; a convention with no
  armed check → `uncheckable` (emit from the union of scan conventions minus armed
  fingerprints, if the convention set is available; else the UI derives `uncheckable`).
- Persist `drift` on the checks-state last-run record (`store/checks_state.rs`, additive).
- **Fail-visible:** never emit `clean`/`drifted` when counts are unknown — that path is
  `errored`. Reuse the T7 per-check timeout + the #185-item-3 flaky-retry policy (security
  kinds excluded — depend on #185 items 2+3 having merged).
- Tests: fixture armed checks (one lint-meta, one shell) → correct site counts + drift
  statuses; unparseable output → `errored`, not `clean`; convention with no check →
  `uncheckable`.
- **Merge dependency:** the #185-item-2/3 agent rewrites `lint_wiring.rs` +
  `run_check_with_retry` in this exact subsystem. This slice launches only AFTER that PR
  merges, then rebases on it.

### Slice 3 — lint-meta machine-readable count reporter  (tools/lint-meta)  ·  independent
- Give the lint-meta runner a machine-readable output mode (e.g. `--json` / a reporter)
  emitting per-rule violations: `{ ruleId, filePath, line, column, message }[]` plus a
  per-rule count summary, so EnforceRun (slice 2) can turn a lint-meta run into
  `sitesMatched`/`sitesChecked` per convention. Keep the human/CI text reporter as default.
- Tests: the JSON reporter emits the expected shape + counts on a fixture with N known
  violations across M files.
- Fully collision-free with the current wave (nothing in flight touches `tools/lint-meta`).

### Slice 4 — Enforce UI: render drift  (apps/web)  ·  HOLD for slices 1 + 2
- Upgrade `apps/web/src/components/harness/RuleCoverageGaps/` (or a sibling drift panel) to
  render, per convention: coverage status AND — when an armed check exists — the drift
  `status` + `method` + `sitesMatched`/`sitesChecked`. Honest empty/`uncheckable`/`errored`
  states. `clean`/`drifted` chips ALWAYS show method + counts.
- Wire the drift data from the extended checks-state / EnforceRun result through the
  existing `harness-data.hooks.ts` / `harness-coverage.ts` seam.
- Component-lint clean (folder-per-component, no-state-in-body, no-cross-feature-imports);
  a `*.test.tsx` for the drift render + a story.

## v0.4 tail (out of scope for v0.3 — noted so the shapes don't need migrating)

- **Deep-audit opt-in** — an LLM pass that re-reads sites for conventions no mechanical check
  can express (the expensive path, made deliberate + bounded).
- **Carry-forward** — acknowledged-drift persists across runs (keyed on `fingerprint`, like
  dismiss), so a known-and-accepted drift stops re-alarming.
- **ESLint-rule compiler** — the generated-rule substrate, gated on #185's RuleTester runner
  proving a generated rule actually fires.
- **ast-grep substrate** — bundled per-arch (sidecar-matrix-class work).
- **First-class EnforceRun run-record + History row** — drift runs become auditable receipts
  in the History view.
- **Pre-arm sandbox "preview drift"** — run a compiled-but-unarmed check inside the T16
  native sandbox to preview conformance before arming.

## Security notes

- Compiled checks are files written via the **existing hardened `apply.rs`** path — the
  exec-sink denylist is unchanged; a prompt-injected "check" can't land a code-execution
  file, and arming stays human-gated (`arm_harness_gauntlet_check` writes the manifest
  itself — model output is never authority).
- EnforceRun executes **armed checks only** (decision 4). No pre-arm execution in v1.
- lint-meta rules and shell checks are both executable; the human arm-review IS the gate.
  Do not add an auto-arm heuristic (that is the exact prompt-injection→armed-gate hole the
  design guards against — cf. #185 item 2, the substring-defeatable wiring gate).

## How to verify

- `bun run lint` + `bun run lint:meta` (zero violations), `bun run test:node`,
  `bun run --filter @nightcore/web typecheck` + `test`.
- From `apps/desktop/src-tauri`: `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test` (regenerates ts-rs + runs the drift/enforce tests).
- Dogfood: run a harness scan on a scratch repo → arm a compiled lint-meta check → "Run armed
  checks now" → confirm a `ConventionDrift` chip renders WITH method + site counts, and a
  convention with no armed check reads `uncheckable`.
