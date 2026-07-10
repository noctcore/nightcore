# Research: real ENFORCE — convention drift + rule-coverage detection

**Date:** 2026-07-10
**Ticket:** wayfinder #87 (gates #94 "ENFORCE Phase-1 scope: re-slice now or wait")
**Status:** complete (research only — no code changes)
**Prior art:** `docs/research/2026-07-10-scan-views-rethink.md` (the ENFORCE caveat, §"Evaluation of the user's Harness PROPOSE/ENFORCE split")

## The question

The scan-views rethink established that the Harness PROPOSE/ENFORCE split is a real
product framing, but ENFORCE is under-built: today Harness *detects* conventions and
gaps; it does not *check adherence*. Real ENFORCE means two capabilities:

- **(a) Convention drift** — "is convention X actually followed at all N sites?"
- **(b) Rule-coverage gaps** — "which observed conventions have no enforcing lint rule?"

This memo maps what exists, sketches contracts, prices the LLM/deterministic/hybrid
variants, and ends with what Phase 1 can honestly ship.

---

## 1. What exists today (findings, with refs)

### 1.1 The Harness scan's output is already drift-shaped — but unverified

- `ConventionFindingSchema` (`packages/contracts/src/harness.ts:52-76`) carries
  `kind: 'convention' | 'gap'` (`harness.ts:42`), a **list** of grounded evidence anchors
  (`evidence: FindingLocation[]`, `harness.ts:65`), a `suggestion` ("the concrete rule to
  codify"), free-form `tags`, and a **stable fingerprint** = sha1 of `category | normalized
  title` (`packages/engine/src/scans/harness/findings.ts:46-52`). The fingerprint already
  survives re-runs and dedups across passes — the natural join key for drift/coverage records.
- The output contract *forces the model to state each convention as an enforceable RULE*
  (`packages/engine/src/scans/harness/presets.ts:115-136`: "Report the DE-FACTO convention
  AS A RULE so it can be codified and ENFORCED"). So the input to a drift checker — a
  rule statement + a few example sites — already exists per finding.
- **What's missing:** evidence is 0–5 *illustrative* anchors, capped at 8 findings/lens
  (`manager.ts:60`), grounded only for *existence* (`findings.ts:145-160` — file exists,
  lines clamped; fileless findings are kept). Nobody enumerates the population of sites a
  convention applies to, and nobody checks conformance. `harness-category-completed`
  (`harness.ts:365-375`) has no site counts, no adherence status.
- `RepoProfile` (`harness.ts:119-137`) is a deterministic fs pass (no model —
  `packages/engine/src/scans/harness/repo-profile.ts`, called from `manager.ts:87-100`)
  that already detects `hasEslintFlatConfig` (:129), `hasLintMeta` (:131), `hasAgentDocs`
  (:133), `existingPlugins` (:135) — the *presence* of enforcement tooling in the TARGET
  repo, but not its **rule inventory**. Coverage detection needs the inventory.
- The `tooling-lint` lens already *asks* for coverage gaps in prose
  (`presets.ts:74-84`: "whether rules are actually enforced (error vs warn vs off) … the
  gaps where conventions are unenforced") — so today, rule-coverage detection exists only
  as fuzzy, unjoined LLM findings from one lens. The new capability is making that a
  deterministic join.

### 1.2 The scan spine gives an ENFORCE run its skeleton for free

- Abstract `ScanManager` (`packages/engine/src/scans/shared/scan-manager.ts:206`) owns
  started → `prepare` → bounded fan-out (pool of 6, `scan-manager.ts:44`) → per-item
  parse/ground + one corrective retry → `finalize`. A drift scan is a subclass where
  **items = conventions** instead of categories; nothing in the base assumes items are an
  enum (TItem is generic, `scan-manager.ts:206-212`).
- The tail-session helper (`shared/tail-session.ts`, used by synthesis at
  `packages/engine/src/scans/harness/synthesis.ts:106`) is the ready-made seam for a
  single cheap "join" pass in `finalize` (coverage) without a new fan-out.
- The bounded repo inventory (`shared/inventory.ts:1-30`) is threaded into `finalize`
  (`scan-manager.ts:193-198`) — reusable by any enforce tail.

### 1.3 Deterministic machinery that already exists (the big lever)

- **lint-meta** (`tools/lint-meta/`): rules are pure functions of an `IMetaCtx`
  (`types.ts:9-42` — `read`/`exists`/`glob`/`exec`), registered in one array
  (`registry.ts:28-49`, 20 rules), with a **ratchet baseline** mechanism
  (`types.ts:35-41`, `baselines/*.json`). This is *Nightcore's own* meta-linter, but its
  shape — "a check = glob + read + assert, returning violations" — is exactly the check
  DSL a compiled drift check needs.
- **@nightcore/eslint-plugin** (`packages/eslint-plugin/src/rules/` — 13 rules): the rule
  inventory is discoverable from one file, `configs/recommended.ts:9-22`; actual on/off
  wiring lives in the root `eslint.config.mjs`.
- **The coverage-checking precedent already ships**: `agent-contract-parity`
  (`tools/lint-meta/rules/agent-contract-parity.ts:17-44`) regexes the wired rule names
  out of `recommended.ts` and diffs them against AGENTS.md text — a deterministic
  "inventory vs. claims" join, CI-critical. RuleCoverageGap is the same join with
  ConventionFindings on the other side.
- **The enforcement runtime already runs deterministic checks**: the Structure-Lock
  gauntlet loads `.nightcore/harness.json`, plans checks, and executes them
  (`apps/desktop/src-tauri/src/workflow/gauntlet_project/config.rs:20-39` — 9
  `HarnessCheckKind`s including `lint-plugin` and **`ast-grep`**; `runner.rs:17-28` —
  `run`/`run_from` with the manifest-root/run-dir split). Arming is human-gated and
  allowlisted (`apps/desktop/src-tauri/src/sidecar/harness/commands.rs:37-62`,
  `ARMABLE_CHECK_KINDS`), merge-by-name idempotent (`commands.rs:435`).
  **A "drift check compiled once, run forever" needs almost no new runtime** — it needs a
  way to run the armed checks *as a scan* (on demand, repo-wide) instead of only per-task.
- **Synthesis already generates enforcement artifacts**: `ArtifactKindSchema`
  (`harness.ts:149-161`) includes `lint-meta-rule` / `eslint-rule` / `eslint-plugin-file`;
  the hardened write path is `sidecar/harness/apply.rs`. The hybrid variant's
  "LLM writes the check" is a new *artifact kind + prompt focus*, not a new pipeline.

### 1.4 Recurrence / caching precedent

- Insight carries `converted` and `dismissed` fingerprints across runs
  (`apps/desktop/src-tauri/src/store/insight.rs:327-341`); harness findings share the
  fingerprint idiom (`findings.ts:46-52`). Drift results keyed by
  `conventionFingerprint` inherit this for "acknowledged drift" carry-forward.
- All run stores are `RunStore<R>` type aliases (`store/run_store.rs:1`), `MAX_RUNS=50`.

### 1.5 Measured baseline costs (real logs, this repo)

From `~/Library/Logs/dev.shirone.nightcore/nightcore.log.*`:

| Run | Scope | Per-pass cost | Per-pass wall | Total |
|---|---|---|---|---|
| Harness full scan (2026-07-02) | 8 lenses + synthesis | $1.39–$1.54 / lens | 144–251 s | **$13.76 / 18 m 12 s**, 63 findings |
| — synthesis tail alone | 1 session | $3.00 | 784 s (13 m) | — |
| Insight full scan (2026-07-04) | 9 categories | $1.64–$15.99 | 294–1163 s | **$48.32 / 19 m 23 s** |

These are the honest unit economics: **one repo-exploring LLM pass ≈ $1.5–3 (up to $16
for heavy lenses) and 2.5–10 minutes.** Any design where drift = one LLM pass per
convention per run multiplies that by the convention count *on every re-run*.

---

## 2. The two capabilities, analyzed

### (a) Convention drift — "followed at all N sites?"

Three mechanically different ways to answer:

1. **LLM sampling per convention.** A `ScanManager` subclass whose items are the
   conventions to audit; each pass gets one convention (title/description/suggestion +
   evidence anchors) and is prompted to *enumerate* the applicable sites (Glob/Grep),
   check a bounded sample, and return violations + site counts. Same read-only toolset
   as a lens (`manager.ts:106-119`). Honest for fuzzy conventions ("error handling goes
   through the taxonomy"), but each pass is a paid exploration.
2. **Deterministic checks generated per convention.** Only conventions expressible as
   AST/glob/regex checks get checked (naming, folder shape, import direction — i.e. most
   of `naming`/`folder-structure`/`imports-boundaries`, some of `architecture`; little of
   `design-decisions`). Runs are free and fast; coverage of the convention space is
   partial *by construction* — which is fine if the UI says so.
3. **Hybrid (compile once, run forever).** The LLM writes the deterministic check ONCE
   (an `eslint-rule` artifact, an `ast-grep` YAML rule, or a lint-meta-style script),
   marks conventions it cannot compile as `uncheckable-deterministically`, the check is
   armed into `.nightcore/harness.json` through the existing human gate, and every
   ENFORCE re-run executes armed checks at ~$0. Model sampling remains an opt-in,
   per-convention "deep audit" for the uncheckable residue.

Site enumeration is the crux: "all N sites" requires a *population definition* (a glob +
an anchor pattern), which is precisely what a compiled check encodes and what a one-off
LLM pass re-derives (and re-pays for) every run. That asymmetry is the whole argument
for the hybrid.

### (b) Rule-coverage gaps — "which conventions have no enforcing rule?"

Mostly deterministic, following the `agent-contract-parity` template:

1. **Inventory extraction (deterministic, fs-only, like `detectRepoProfile`):**
   - ESLint: best-effort textual parse of `eslint.config.*` for rule ids at
     `error|warn` (Phase-1 honest limitation: flat configs that compute rules
     dynamically resolve only via `eslint --print-config`, which needs exec in the
     target — defer to the Rust exec seam, see §5).
   - lint-meta-style registries when present (`RepoProfile.hasLintMeta`).
   - `.nightcore/harness.json` armed checks (via `store/harness_manifest.rs`).
   - AGENTS.md/CLAUDE.md **claims** (regex for rule names/guardrail headings — the
     `agent-contract-parity.ts:29-42` glob-and-grep approach, generalized).
2. **The join (semantic, one cheap LLM call):** "no-cross-feature-imports the finding"
   ↔ `nightcore/no-cross-feature-imports` or `import/no-restricted-paths` the rule is a
   fuzzy semantic match; a single no-tool completion with the deduped findings + the
   inventory in the prompt does this well. ~8–20k input / 2–4k output tokens →
   **$0.10–0.50, under a minute**, run in `finalize` via `runTailSession`. A
   deterministic tag/keyword pre-match can short-circuit the obvious pairs.

Output statuses: `enforced` (a rule at error covers it) / `documented-only` (an agent
doc claims it, no rule) / `unenforced` (nothing). `documented-only` is the
agent-contract-parity insight inverted: docs without teeth.

---

## 3. Contract sketches (zod idioms: flat, codegen-friendly)

New file `packages/contracts/src/harness-enforce.ts` (as anticipated by the rethink
memo). Plain shapes carry the `Schema` suffix + inferred type twin; event members use
the `Event` carve-out (`packages/eslint-plugin/src/rules/zod-schema-naming.ts:12-23`);
wire strings kebab-case for clean Rust enum codegen.

```ts
import { z } from 'zod';
import { runTotals, scanFailure, TokenUsageSchema } from './event-fragments.js';
import { FindingLocationSchema } from './insight.js';
import { ConventionCategorySchema } from './harness.js';

/** How a drift verdict was produced. `deterministic` = an armed/compiled check ran;
 *  `model` = a paid sampling pass; `stale` = carried forward from a prior run
 *  because the checked sites' content hashes were unchanged. */
export const DriftMethodSchema = z.enum(['deterministic', 'model', 'stale']);
export type DriftMethod = z.infer<typeof DriftMethodSchema>;

export const DriftStatusSchema = z.enum(['followed', 'drifting', 'unknown']);
export type DriftStatus = z.infer<typeof DriftStatusSchema>;

/** One convention's adherence report. Flat; lifecycle (acknowledged) is owned by
 *  the Rust store, applied on persist — mirroring ConventionFinding. */
export const ConventionDriftSchema = z.object({
  id: z.string(),
  /** Joins back to the ConventionFinding (its stable category|title sha1). */
  conventionFingerprint: z.string(),
  category: ConventionCategorySchema,
  /** The convention, restated as the rule that was checked. */
  title: z.string(),
  status: DriftStatusSchema,
  method: DriftMethodSchema,
  /** Population + violations. sitesChecked < sitesMatched ⇒ sampled, not exhaustive. */
  sitesMatched: z.number().int().default(0),
  sitesChecked: z.number().int().default(0),
  violations: z.array(FindingLocationSchema).default([]),
  /** The armed check that produced this, when deterministic (manifest `name`). */
  checkName: z.string().optional(),
  /** Model self-rated confidence 0..1 (model method only). */
  confidence: z.number().optional(),
  /** Stable fingerprint (conventionFingerprint — one drift record per convention). */
  fingerprint: z.string(),
});
export type ConventionDrift = z.infer<typeof ConventionDriftSchema>;

export const CoverageStatusSchema = z.enum([
  'enforced',        // a lint/meta rule at error covers it
  'documented-only', // an agent doc claims it; no rule enforces it
  'unenforced',      // neither
]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

/** One convention's enforcement coverage. */
export const RuleCoverageGapSchema = z.object({
  id: z.string(),
  conventionFingerprint: z.string(),
  category: ConventionCategorySchema,
  title: z.string(),
  status: CoverageStatusSchema,
  /** Enforcing rule ids found (`nightcore/no-cross-feature-imports`, a lint-meta id,
   *  an armed harness-check name). Empty unless status === 'enforced'. */
  enforcedBy: z.array(z.string()).default([]),
  /** Agent-doc anchors that claim it (repo-relative path, optional heading). */
  documentedIn: z.array(z.string()).default([]),
  /** What synthesis could generate to close the gap (feeds PROPOSE). */
  suggestedArtifactKind: z.string().optional(), // ArtifactKind wire string, lenient
  fingerprint: z.string(),
});
export type RuleCoverageGap = z.infer<typeof RuleCoverageGapSchema>;
```

Command + events (idioms: `StartHarnessScanCommand` at `commands.ts:237`; harness event
family at `harness.ts:342-422`):

```ts
// commands.ts — StartHarnessEnforceCommand / CancelHarnessEnforceCommand
//   { type: 'start-harness-enforce', runId, projectPath,
//     conventionFingerprints?: string[],   // selective drift; default = all armed/checkable
//     deepAudit?: boolean,                 // opt-in model passes for uncheckable conventions
//     providerId?, model?, effort?, maxConcurrency?, maxBudgetUsdPerConvention? }

// harness-enforce.ts — event family (Event carve-out, no Schema suffix):
//   HarnessEnforceStartedEvent      { runId, conventionCount, model }
//   HarnessEnforceCheckCompletedEvent { runId, drift: ConventionDriftSchema,
//                                       usage?: TokenUsageSchema, costUsd }
//   HarnessEnforceCompletedEvent    { runId, drifts: [...], gaps: RuleCoverageGapSchema[],
//                                     ...runTotals }
//   HarnessEnforceFailedEvent       { runId, ...scanFailure }
```

Additive alternative (cheaper, less clean): extend `harness-scan-completed` with
`coverage: RuleCoverageGapSchema[].default([])` — zero new event family, old runs load
fine (the `proposals` `.default([])` precedent at `harness.ts:407`). This is the right
move for coverage-only Phase 1; the full event family is only needed when drift becomes
a run of its own.

---

## 4. Design variants, cost and effort

Sibling-cost baseline from the rethink memo: a full new scan sibling ≈ 2,500–4,000 LOC /
40–70 files across all four tiers.

### Variant 1 — "ENFORCE-lite": coverage-gap detection only (deterministic + one cheap join)

Rule inventory extraction (fs-only, `detectRepoProfile`-style) + AGENTS-claims regex +
one no-tool LLM join pass in the Harness scan's `finalize`. Results ride the existing
harness run additively (coverage badge per ConventionFinding + a Gaps panel in the
Enforce destination). No drift claims.

| | |
|---|---|
| Token cost / run | **+$0.10–0.50**, <60 s added to an existing $13–14 scan |
| Re-run cost | same (it re-joins each scan; the join is the cheap part) |
| Contracts | `RuleCoverageGapSchema` + additive field on `harness-scan-completed` (~80–150 LOC) |
| Engine | inventory module ~200–350 LOC; join pass ~150–250 LOC; tests |
| Rust | serde-additive field on `HarnessRun` (~100–250 LOC incl. ts-rs regen) |
| Web | badge/column + gaps section in the Enforce split (~300–600 LOC) |
| **Total effort** | **~0.8–1.6k LOC — one worktree slice, days** |

### Variant 2 — LLM drift sampling (a per-convention `ScanManager` fan-out)

`EnforceManager extends ScanManager<StartHarnessEnforce, ConventionRef, …>`; items =
selected conventions; per-item pass enumerates sites and samples adherence.

| | |
|---|---|
| Token cost / run | **$0.5–1.5 per convention** (narrower than a lens, still explores). All 63 findings from the measured run: **$30–95 and 40–60 min** at pool 6. Selective (5–10 armed): **$3–15 / 5–15 min** |
| Re-run cost | *identical every time* — this is the killer for a recurring-by-design feature. Mitigable by fingerprint-gating (skip conventions whose enumerated sites' content hashes are unchanged — requires persisting site lists + hashes per convention, a new mechanism) |
| Effort | mode-flag on Harness or new sibling: contracts ~150–250, engine subclass ~350–550, Rust store ~300–600, web run surface ~800–1,500 ⇒ **~1.6–3k LOC** |
| Strength | the only variant that honestly audits fuzzy conventions (`design-decisions`, prose-y `architecture`) |

### Variant 3 — Hybrid: compile the check once, run it forever (recommended target)

A check-compilation tail (synthesis's twin — `runTailSession`, capped like
`MAX_ARTIFACTS=24` at `synthesis.ts:54`) turns each checkable convention into a
deterministic check artifact: an `eslint-rule`, an `ast-grep` YAML, or a lint-meta-style
script. Checks flow through the EXISTING human-gated arm path
(`ARMABLE_CHECK_KINDS` already includes `lint-plugin` and `ast-grep`,
`sidecar/harness/commands.rs:37-47`; merge-by-name `commands.rs:435`; hardened writes
via `apply.rs`). An ENFORCE run = execute armed checks repo-wide + the Variant-1
coverage join; conventions the compiler marks uncheckable fall back to Variant-2 model
passes **only when the user opts in** (`deepAudit`).

| | |
|---|---|
| One-time cost / repo | check compilation ≈ synthesis: **~$2–5, 8–15 min** (single tail session, capped) |
| Recurring run cost | **~$0 tokens + $0.10–0.50 coverage join; wall-clock = eslint/ast-grep over the repo (seconds–minutes)** — the economics recurring ENFORCE needs |
| Cache story | trivially good: deterministic checks are cheap enough to always re-run; drift statuses keyed by `conventionFingerprint`; "acknowledged" carry-forward copies `insight.rs:327-341` |
| Effort | Variant 1 + compiler tail (~300–500 engine LOC) + on-demand deterministic executor in **Rust** (extend `gauntlet_project::runner::run_from` into a scan-shaped command emitting an EnforceRun, ~300–500 LOC) + run surface (~600–1,000 web LOC) + optional Variant-2 fallback ⇒ **~2–3.5k LOC**, but heavily composed of shipped, audited parts |
| Honest limits | deterministic coverage of the convention space is partial; `sitesChecked/sitesMatched` + `method` in the contract keep the UI honest; ast-grep checks require the `ast-grep` binary in the target's toolchain (same class of prereq as `npx eslint`) |

---

## 5. Cross-cutting design notes

- **Exec stays in Rust.** The engine is read-only-analysis by design (scan passes get
  Read/Glob/Grep only, `manager.ts:112-113`; writes live in `apply.rs`; check execution
  lives in `gauntlet_project/runner.rs`). Running compiled checks from the engine would
  hand it arbitrary-exec powers and breach the trust-boundary story. The ENFORCE
  deterministic leg should be a Rust command reusing the gauntlet planner/runner
  (`runner.rs:28` `run_from` already separates manifest root from run dir); the engine
  contributes only the model legs (compilation tail, coverage join, deep-audit passes).
  This makes an ENFORCE run a *two-actor* run — new territory for the scan spine, and
  the main architectural cost of Variant 3.
- **Population honesty.** Never render "followed" without `sitesMatched`/`sitesChecked`;
  an LLM sample is a sample. The `method` + counts fields exist to keep the grid honest.
- **Selective by default.** Drift checking should run over *armed/selected* conventions
  (the `conventionFingerprints` command field), not all findings — both for cost (V2)
  and for signal (users care about the conventions they chose to enforce).
- **Coverage inventory is best-effort in Phase 1.** Textual flat-config parsing misses
  computed configs; say so in the UI ("inventory: 12 rules found in eslint.config.mjs")
  and harden later via a Rust-side `eslint --print-config` exec seam.
- **Codegen tax applies to every variant:** new zod schemas → Rust `generated.rs`, Rust
  store types → ts-rs (`cargo test` regenerates), plus `scan-family-parity` enrolment if
  a new web run surface appears (`tools/lint-meta/rules/scan-family-parity.ts:31-39`).

## 6. Recommendation

**Ship Variant 1 now inside the Phase-1 re-slice; build Variant 3 as the Phase-2 "real
ENFORCE"; offer Variant 2 only as an opt-in, price-tagged deep audit — never the
recurring default.**

Rationale: coverage-gap detection is the half of ENFORCE that is nearly free
(deterministic inventory + a <$0.50 join), reuses a shipped precedent
(`agent-contract-parity`), and produces the exact artifact PROPOSE consumes next
("unenforced convention → generate the rule"). Drift's honest recurring economics only
work compiled-deterministic; the compile-and-arm machinery (synthesis, apply path,
armable kinds, gauntlet runner) is already built and audited — Variant 3 is mostly
composition plus one new seam (on-demand Rust check execution surfaced as a run).
Pure-LLM drift at $30–95 per full re-run is not a product, it's a demo.

## 7. The #94 answer: what Phase 1 can honestly ship vs. what real ENFORCE adds

**Re-slice now — don't wait for drift.** Phase 1's Enforce destination can honestly ship:

1. The existing Conventions/gaps grid + Policy manifest + gauntlet-arm surface
   (a pure view re-slice, per the rethink memo's Phase-1 plan), **plus**
2. Variant-1 coverage: per-convention `enforced / documented-only / unenforced` badges
   and a Rule-Coverage-Gaps panel — new, real ENFORCE signal at **+$0.10–0.50 per scan
   and ~0.8–1.6k LOC (one worktree slice)**.

What Phase 1 must NOT claim: site-level adherence. Label the screen "coverage, not
conformance" until drift lands.

**What real ENFORCE (drift) adds and its price:** "convention X is followed at N of M
sites, here are the violations" — via Variant 3 at **~2–3.5k LOC of mostly-composition
build, ~$2–5 one-time check compilation per repo, then ~$0 recurring runs**; with
Variant-2 deep audits ($0.5–1.5 per convention, user-invoked) covering the
deterministically-uncheckable residue. The `ConventionDrift` contract (§3) is designed
so Phase-1 shapes (`RuleCoverageGap`, the additive `coverage` field) never need
migration when drift arrives — `conventionFingerprint` is the stable join key across
all of it.
