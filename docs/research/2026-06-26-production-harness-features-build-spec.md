# Production-Harness Features — 4-Tier Build Specs

*2026-06-26. Four new Nightcore capabilities that drag a **target** project up to production grade and
keep agents on-rails so they can't degrade its structure/quality. Each is specced against the exact
wiring of its closest existing sibling (file:line verified), so most of the work is *reuse*, not new
architecture.*

> **The loop these complete.** Insight already does **Profile**. Harness already does the start of
> **Harden**. These four close the loop so the harness you generate becomes the constraint envelope every
> future agent run executes inside:
>
> **Profile** → `Readiness Scorecard` · **Harden** → `Custom Lint-Plugin Generator` · **Lock** →
> `Pre-flight Context Pack` · **Verify** → `Structure-Lock Gauntlet`.

Tier legend (Nightcore's standard 4+1): **Contracts** (`packages/contracts`, zod ⇄ Rust codegen) →
**Engine** (`packages/engine`, the SDK-facing brain) → **Rust store** (`src-tauri/src/store`,
JSONL/JSON persistence) → **Sidecar/commands** (`src-tauri/src/sidecar`, Tauri commands + event readers)
→ **Web view** (`apps/web/src/components`, folder-per-component). Codegen is bidirectional — don't
hand-edit `generated.rs` or `apps/web/src/lib/generated/`; `cargo test` regenerates ts-rs.

---

## 1 · Readiness Scorecard *(Profile — the headline view)*

**What it does.** A per-dimension production-readiness grade (A–F) for the active project — Architecture ·
Tests · Security · Error-handling · Observability · Dependencies · Performance · Types · A11y · Docs/CI.
Each cell is grounded in evidence and carries a **"Harden this"** button that dispatches the matching
`kirei-*`/skill scanner as a board task. It's Insight's twin: *find→fix* becomes *grade→harden*.

**Sibling to clone:** the **Insight** feature, end to end. ~80% is a structural copy with three real
divergences (grade not severity; dimension-dispatch not Claude-pass; no dismiss).

| Tier | Build |
|---|---|
| **Contracts** | New `packages/contracts/src/scorecard.ts`: `ScorecardGradeSchema = z.enum(['A','B','C','D','E','F'])`, `ScorecardDimensionSchema` (the 10 dimensions), `ScorecardReadingSchema` (id, dimension, grade, summary, findings[], evidence[] — mirrors `FindingSchema` at `insight.ts:72` minus severity/effort), `StartScorecardCommand` (mirror `StartAnalysisCommand` at `commands.ts:114`; `categories`→`dimensions`, keep `model`/`effort`/`maxConcurrency`/`maxBudgetUsd`), and `scorecard-*` events mirroring `analysis-*` (`events.ts:315-362`). Export from `index.ts`. |
| **Engine** | New `ScorecardManager` ≈ copy of `AnalysisManager` (`analysis-manager.ts:110`): reuse `runPool` (bounded concurrency), `buildRepoInventory` (`:531`), and the grounding helpers `groundFindings`/`fingerprintOf` (`analysis-findings.ts`) **verbatim**. **Divergence:** `runCategory`→`runDimension` dispatches the **skill/kirei scanner** (`/<skillName>` via the Skill tool) instead of a fixed Claude analysis pass; new `parseReading()` extracts the A–F grade + findings (reuse `extractJson`). New `scorecard-presets.ts` ≈ `analysis-presets.ts` but each preset is `{ dimensionKey, skillName, skillArgs, gradeRubric }` instead of `{ category, focus }`. Keep `ANALYSIS_ALLOWED_TOOLS` (read-only) for the grade pass. |
| **Rust store** | New `store/scorecard.rs` ≈ `store/insight.rs`: `ScorecardRun`/`ScorecardReading`/`ScorecardStore` mirroring `InsightRun`/`StoredFinding`/`InsightStore` (`insight.rs:160,62,185`). Reuse `upsert`/`prune_locked` (MAX_RUNS=50)/`reap_running` (`:275,286,313`) and the atomic TOCTOU-safe `link_finding_task`→`link_reading_task` (`:414`). **Drop** `dismissed_fingerprints` + cross-run dedup (each scorecard run is fresh). Dir: `.nightcore/scorecards/`. |
| **Sidecar** | New `sidecar/scorecard.rs` ≈ `sidecar/insight.rs`: `start_scorecard`/`cancel_scorecard`/`list_scorecard_runs`/`get_scorecard_run`/`delete_scorecard_run`, plus `convert_reading_to_task` (clone `convert_finding_to_task` at `:212` — mint-task-first then atomic link; map dimension→skill task kind so "Harden Security" creates a `/security-audit` card). New `handle_scorecard_event` ≈ `handle_analysis_event` (`:333`) minus dismissed-history reconciliation. |
| **Web** | New `components/insight`-style `components/scorecard/`: `ScorecardView` (Config→Running→Results via `RunLifecycleShell`), `DimensionGrid` (rows = dimensions, a big A–F grade chip + sparkline per row — replaces `FindingGrid`), `ReadingDetailPanel` (grade badge + summary + evidence + **"Harden this"** button only — no dismiss/restore), and `scorecard-stream.ts` with `foldScorecard` ≈ `foldInsight` (`insight-stream.ts:161`). Add a sidebar nav chip + route. |

**Effort:** **M–L.** **Depends on:** nothing hard, but it's the natural front door to the other three (its
"Harden this" buttons dispatch the Lint-Plugin Generator and the kirei hardening skills). **Risk:** the
grade rubric needs to be deterministic enough to be trustworthy — pin each dimension's A–F thresholds in
`scorecard-presets.ts` and show the evidence, don't let the model freestyle the letter.

---

## 2 · Custom Lint-Plugin Generator *(Harden — the one you named)*

**What it does.** From the conventions Harness already detects, **generate a real, project-specific lint
plugin in the repo** — actual AST rules (`no-cross-feature-imports`, `folder-per-component`,
`no-state-in-body`, naming) packaged as an ESLint/Biome plugin + a lint-meta config — so the project's own
conventions become machine-enforced, for humans *and* agents. This is literally what Nightcore's own
`@nightcore/eslint-plugin` does, generated per target.

**Sibling to extend:** the **Harness** synthesis+apply pipeline. The artifact machinery, multi-file
bundling, and the security-critical write path **already exist** — this is mostly teaching synthesis a new
artifact kind.

| Tier | Build |
|---|---|
| **Contracts** | One-line core change: add `'custom-lint-plugin'` to `ArtifactKindSchema` (`harness.ts:143-149`). `ProposedArtifactSchema` (`:165`) already carries `group` (multi-file bundles), `dependsOn[]`, `writeMode`, `targetPath` — everything a plugin package needs. Add `'custom-lint-plugin'` to `ARTIFACT_KIND_META`. |
| **Engine** | Extend `artifactOutputContract()` (`harness-synthesis.ts:254-280`) to describe the new kind: emit the plugin as **several `eslint-plugin-file` artifacts sharing one `group`** (scaffold `index.js` + one file per rule + a `tests/` fixture), exactly the pattern the contract already notes at `:273`. Add a worked example to `HARNESS_REFERENCE` (`harness-reference.ts:9`) showing a real AST rule (selector + report + fix) derived from a convention finding. `coerceArtifact`/`parseProposedArtifacts` (`:329,311`) validate it for free. **Optional:** enforce `dependsOn[]` ordering so scaffold writes before rules. |
| **Rust store** | **No change.** `StoredProposedArtifact.kind` (`harness.rs:102`) is a string; lifecycle (`mark_artifact_applied`, `prior_artifact_states`) is kind-agnostic. |
| **Sidecar** | **No change to the write path** — `apply_harness_artifact` (`harness.rs:209`) routes purely on `writeMode`, and `safe_join`'s 3-layer symlink/clobber defense (`:292-361`) + `write_create`/`write_merge_section` already secure any kind. (Optional polish: a "wire the plugin into the existing eslint config" branch at `:235` using `merge-section`, so applying the plugin also registers it.) |
| **Web** | Renders **automatically** — `HarnessProposalList.groupArtifacts` (`:17`) already groups multi-file bundles, `ArtifactDetailPanel` + `ApplyConfirmDialog` + the `safe_join` error surfacing already work. Only add the `ARTIFACT_KIND_META` label and (nice-to-have) a "this is a multi-file plugin — N files" affordance on the group card. |

**Effort:** **S–M** (the cheapest of the four — the dangerous part, the write path, is done and tested).
**Depends on:** Harness (exists). **Pairs with:** feature #4 — a generated lint plugin is only as good as
the gauntlet that runs it. **Risk:** generated AST rules can be subtly wrong; ship them with the generated
`tests/` fixtures so the plugin self-verifies, and apply via the existing no-clobber `create` mode so a
human reviews before it's load-bearing.

---

## 3 · Structure-Lock Gauntlet *(Verify — the agent-reliability core)*

**What it does.** After every task, run **the project's own generated lint plugin + architecture-boundary
check (dependency-cruiser/import rules) + coverage thresholds** as a deterministic gate, *before* the paid
reviewer. Code that breaks the harness can't merge — it routes to the bounded auto-fix loop or parks. **An
agent literally cannot degrade the structure you locked**, and broken builds stop burning reviewer
sessions.

**Sibling to extend:** the **verification gauntlet** + verify state machine. Two clean insertion points
already exist; the gauntlet's tooling-detection pattern is the template.

| Tier | Build |
|---|---|
| **Contracts** | Add `StructureLockResult`/`StructureLockCheck` (parallel to `GauntletResult`/`GauntletStep`, `gauntlet.rs:80,55`) — `{ passed, checks[], failedCheck? }`. Add a `structure_lock_result: Option<StructureLockResult>` field to the `Task` model (serde-additive, same pattern as `verified`). Define a per-project `.nightcore/harness.json` schema: `{ checks: [{ name, kind: lint-plugin|dependency-cruiser|coverage-threshold, command|configPath, enabled }] }`. |
| **Engine** | None (this gate is pure Rust + shell, no model). |
| **Rust store** | Tiny: load/validate `.nightcore/harness.json` (serde, warn-and-skip malformed, **absent ⇒ skip all checks** so existing projects are unaffected). It's written by feature #2 (the generator emits this config alongside the plugin). |
| **Sidecar/workflow** | New `workflow/gauntlet_project.rs` modeled on `gauntlet.rs::run` (`:212`): for each enabled check, spawn via `crate::platform::std_command()` (inherits the Windows-shim handling), stop-at-first-failure, tail 4000b (reuse `tail_output` at `:291`). **Insertion #1** — `verification.rs:89-97`, right after status flips to `Verifying`, before `dispatch_reviewer` (`:293`): on failure, set `WaitingApproval`/`verified=false` and park, *or* feed the failing check into the existing `dispatch_fix` auto-fix loop (`MAX_FIX_ATTEMPTS=2`, `:24`) so the agent self-corrects. **Insertion #2** — `merge.rs:105`, alongside the existing pre-merge gauntlet re-run, so a stale worktree can't merge past the lock either. |
| **Web** | Extend `GauntletResults` (`board/GauntletResults`) to render the structure-lock checks (reuse the ✓/✕/– glyph map in `GauntletResults.hooks.ts`), and add a destructive alert at the top of `ReviewPanel` when `structure_lock_result.passed === false` naming the failed check. |

**Effort:** **M.** **Depends on:** ideally #2 (to *have* a generated plugin to run) — but works standalone
against any hand-written `.dependency-cruiser.json` / coverage config. **Risk:** false-positive gates are
worse than no gate (they train users to ignore the lock) — default `harness.json` to *absent*, make every
check opt-in, and surface the exact failing command so a human can reproduce it.

---

## 4 · Pre-flight Context Pack *(Lock — makes every agent run better for free)*

**What it does.** Before any task runs, inject a curated, **Nightcore-controlled** context pack — the
project Constitution (the Harness `CLAUDE.md`/`AGENTS.md`), an architecture summary, the active convention
rules, and `.nightcore/memory/*.md` — into the agent's `appendSystemPrompt`. The agent *starts* knowing the
project's rules instead of rediscovering (or violating) them. Crucially it's injected via
`appendSystemPrompt`, **not** `settingSources`, so it's trusted Nightcore content — unlike the repo's own
`CLAUDE.md`, which the SDK already auto-loads as *untrusted* input (the prompt-injection caveat from the
roadmap).

**Sibling to extend:** the session-runner prompt-assembly path. The `appendSystemPrompt` seam already
exists (today only the reviewer persona uses it); this fills it for every run.

| Tier | Build |
|---|---|
| **Contracts** | Add `appendContextPack?: string` to `StartSessionCommand` (`commands.ts:23-58`) — the only new wire field. (Alternatively compute it entirely engine-side from `cwd`; the explicit field keeps the Rust core as the trust boundary that decides *what* counts as trusted context.) |
| **Engine** | In `session-runner.ts` `run()` (`:277-279`), compose the final `appendSystemPrompt` as **contextPack → kind-preset persona** (so project rules lead, then the reviewer/build persona). `resolveKindPreset` (`kind-presets.ts:62`) is untouched. Keep it ordered and bounded (truncate the pack to a token budget so it can't crowd out the task). |
| **Rust store** | Assemble the pack from already-on-disk sources: the Harness-generated `CLAUDE.md`/`AGENTS.md`, a short arch summary (from feature #1's scorecard or `kirei-arch`), the active convention findings, and `.nightcore/memory/*.md`. Store the curated/edited pack at `.nightcore/context.md` (Nightcore-owned). New `store/context.rs` (small) + a `get/set_context_pack` command. |
| **Sidecar** | In the dispatcher (`coordinator.rs:456`, where `provider.start_session(task.prompt(), …)` is called), read `.nightcore/context.md` for the active project and pass it as `appendContextPack`. `Task::prompt()` (`store/task.rs`) is unchanged — context is *system*, not *user*, prompt. |
| **Web** | A small **Constitution editor** surface (reuse `ui/CodeBlock` + the Settings card pattern): view/edit the assembled pack, a "regenerate from Harness + Scorecard" button, and a per-project on/off toggle. Optionally show "context pack: on (N tokens)" on the task-create form so the user knows the agent is on-rails. |

**Effort:** **M.** **Depends on:** strongest when fed by #1 (arch summary) and Harness (`CLAUDE.md`), but
works immediately with just `.nightcore/memory` + the Harness contract. **Risk:** keep it *trusted* —
assemble only from Nightcore-owned files; never fold the target repo's raw `CLAUDE.md` into the trusted pack
(that's the untrusted path the trust-gate governs). Budget the size so it doesn't dominate context.

---

## Build order & dependency graph

```
Harness (exists) ──┬─► #2 Custom Lint-Plugin Generator ──► #3 Structure-Lock Gauntlet
                   │        (emits .nightcore/harness.json) ──┘   (runs what #2 generates)
                   └─► #4 Pre-flight Context Pack ◄── #1 Readiness Scorecard
Insight (exists) ──────► #1 Readiness Scorecard ──► "Harden this" dispatches #2 + kirei skills
```

**Recommended sequence**
1. **#1 Readiness Scorecard** — highest visible value, pure clone of Insight, becomes the front door whose
   "Harden this" buttons drive everything else.
2. **#2 Custom Lint-Plugin Generator** — cheapest (S–M), extends Harness, produces the artifact #3 enforces.
3. **#3 Structure-Lock Gauntlet** — turns #2's output into an actual agent guardrail (the reliability core).
4. **#4 Pre-flight Context Pack** — compounds: makes every agent run start on-rails, fed by #1 + Harness.

**Why this is cheap.** #1 reuses Insight's grounding/streaming/store/lifecycle wholesale; #2 reuses
Harness's already-hardened `safe_join` write path and multi-file `group` bundling (the risky part is done);
#3 reuses the gauntlet's tooling-detection + the verify state machine's auto-fix loop with two ready-made
insertion points; #4 reuses the existing `appendSystemPrompt` seam. None require touching the coordinator,
slot pool, dependency resolver, or worktree isolation.
