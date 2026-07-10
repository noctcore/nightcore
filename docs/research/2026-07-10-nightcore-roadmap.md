# Nightcore Roadmap — 2026-07-10

**Synthesized from:**
- `docs/research/2026-07-10-competitive-landscape.md` (AutoMaker, Aperant, Vibe Kanban, Conductor, Sculptor, OpenHands + cloud-SaaS category)
- `docs/research/2026-07-10-scan-views-rethink.md` (Insight/Scorecard/Harness/PR-Review/Issue-Triage flow analysis + Harness split evaluation)
- Aligns with, and does not replace, the 2026-06-26 control-panel north star
  (keystone: open TaskKind enum → skill registry; locked decisions stand — that
  analysis was never committed as a repo doc; its decisions are recorded in the
  project planning memory).

## The strategic moment

The two open-source kanban orchestrators Nightcore was modeled against are winding down:
AutoMaker is explicitly unmaintained (last commit 2026-05-22), Vibe Kanban (27.3k★) is
sunsetting after Bloop's shutdown, and Aperant has paused code PRs for a cloud-pivot 3.0
rebuild. The **local-first, open-source, verification-gated orchestrator** slot is being
vacated exactly as Nightcore matures. (Point-in-time facts — re-verify before public claims.)

Meanwhile the survey confirms the moat is real: worktree isolation is table-stakes,
container sandboxing is the frontier a couple chase, but an **enforced pre-merge gauntlet +
structure/convention lock + guardrail battery + injection quarantine** has no direct
equivalent anywhere. Phrase it as *degree + enforcement* (OpenHands has a risk analyzer,
Aperant a QA loop), not absolute absence.

## Positioning

Stop leading with "orchestrate agents" (AutoMaker's verbatim tagline). Lead with
**governed autonomy**: *the autonomous dev studio whose agents can't wreck your
architecture — full-loop autonomy inside an enforced harness.* The original
"AutoMaker successor with better arch/performance" framing is now confirmed but
insufficient — the successor claim is table-stakes (Tauri vs Electron holds up);
the harness is the unclaimed position.

## The view rethink (Scorecard / Insight / Harness)

Verdicts from the code-level analysis:

1. **The "seven parallel wizards" instinct is right in spirit, wrong in count.** Only five
   real scan views exist (Insight, Scorecard, Harness, PR Review, Issue Triage). Lint-Plugin
   Generator (a Harness artifact kind), Structure-Lock Gauntlet (a board-drawer runtime gate),
   and Context Pack (a Settings constitution) are already correctly placed — don't drag them
   into a wizard mold.
2. **Scorecard ≈ Insight-with-a-rubric** — the contracts say so themselves ("Profile twin of
   Insight", ~80% structural copy). Merge candidates.
3. **The Harness PROPOSE/ENFORCE split is real, not cosmetic** — different preconditions
   (no harness vs existing harness), outputs (files to write vs violations/gaps to fix),
   cadence (one-time bootstrap vs recurring drift check), and intent ("set up guardrails" vs
   "am I inside my guardrails"). It maps onto Harness's existing four result tabs:
   PROPOSE = Proposals + Artifacts + RepoProfile (which already detects existing
   lint-meta/plugins to propose in the repo's idiom); ENFORCE = Conventions(gap) + Policy +
   gauntlet arming. Caveat: real ENFORCE (adherence/drift + rule-coverage-gap detection) is
   under-built today and needs modest new capability.
4. **Target: goal-oriented stages that read as the product story** —
   **Understand** (Insight + Scorecard under one shell, find/grade toggle) →
   **Harden** (Harness PROPOSE half) → **Enforce** (Harness ENFORCE half) →
   **Verify** (Structure-Lock Gauntlet per task + PR Review, surfaced where the work is).
   PR Review (concurrent) and Issue Triage (list-driven) stay their own destinations.
5. **De-risking rule:** Phase 1 is a shell/nav re-slice only — run stores and
   `.nightcore/{insights,scorecards,harness}/` stay untouched; deep-links need a source-ref
   compat shim; `scan-family-parity` + codegen move in lockstep; never touch
   `apply_harness_artifact` internals during the regroup.

## Roadmap

### NOW (weeks 1–4) — clarity + shippability

1. **Views Phase 1: Harness split + Understand merge** (kirei-forge scale, multi-tier but
   persistence-free). Delivers the rethink you asked for as mostly a view/nav re-slice.
2. **Releases + auto-update — SHIPPED before this roadmap was written** (correction
   2026-07-10): v0.1.0 released 2026-07-09 with macOS/Windows installers + signed
   auto-update; the research missed it. Remaining work is release *cadence*, not the
   pipeline.
3. **README/positioning rewrite** around governed autonomy. Near-zero cost, highest
   strategic ROI while the niche is empty.

### NEXT (1–3 months) — moat made visible + table-stakes DX

4. **Real ENFORCE capability** — convention-drift detection ("is convention X followed at
   all N sites") + rule-coverage gaps ("which conventions have no enforcing rule"). Turns the
   Phase-1 re-slice into a genuinely new capability and completes the split.
5. **Trust Report per merged task** — flight-recorder + gauntlet results as a human-readable
   governance receipt. Makes the invisible harness demoable; no competitor can show this.
6. **Codex end-to-end** (already specced: codex-sdk runStreamed, app-server model list).
   Turns the AgentProvider seam from architecture into a feature. Depth on Claude+Codex over
   breadth-on-ten — provider breadth is a trap.
7. **Integrated terminal + open-in-editor/Finder for worktrees** — cheapest, most universally
   expected gap (AutoMaker/Aperant/Vibe all have it; companion worktree-gap doc has the matrix).
8. **Views Phase 2 (optional)** — read-only `list_all_scan_runs` aggregator + shared
   `FindingsResultsView`; cross-kind history with zero data migration.

### LATER (3+ months) — thesis-compounding differentiators

9. **Structure-Lock as a portable/exportable artifact** — the Harness governs agents outside
   Nightcore (CI, Claude Code, teammates' editors). Distribution wedge; makes the harness a
   standard rather than a feature.
10. **Governed dev-server + embedded preview** — per-worktree dev server where the browser is
    a *verification signal* (screenshot/console-error gating), not just a viewer.
11. **AI merge-conflict resolution as a gated task** — Aperant's standout feature, but run
    through the gauntlet so it stays governed autonomy.
12. **GitHub Issues → governed task on-ramp** — import → Decompose → gauntlet funnel.
    (Linear only if demand appears; revisits the single-user/team-via-git decision.)
13. **Optional container backend** behind the existing sandbox seam (Sculptor/OpenHands
    direction) — "harden the harness," not "become OpenHands."

## Decisions needed (blocking order, not scope)

- **Adoption-first or moat-first?** Both roadmaps share items; ordering differs. NOW as
  written assumes adoption-first (releases before Trust Report).
- **Scorecard**: fully collapse into Insight as a "grade" lens, or keep as a distinct
  sub-mode under Understand? (~80% copy, but grade→harden skill dispatch genuinely differs.)
- **ENFORCE scope for Phase 1**: re-slice only (ship fast, label honestly) or wait for real
  drift/coverage detection?
- **Issue tracker space**: stay single-user/team-via-git (locked 2026-06-26) or open the
  GitHub-issue on-ramp (item 12)?

## Verification gates for the view work

`bun run lint` + `bun run lint:meta` (parity rule), `bun run --filter @nightcore/web
typecheck`, `cargo test` (regens ts-rs), `bun run dogfood:ui` for nav/deep-link compat.
