# The Nightcore Hardening-Module Catalog

*The authoritative, trackable catalog of the 18 codebase-hardening modules Harness
can generate and Nightcore can enforce — elevated from §4 of the
[2026-07-01 scan-features review](./2026-07-01-scan-features-review-and-harness-v2.md)
into a per-module build spec with current status. Updated 2026-07-02.*

## 1. What this is

Harness's north star is to make a codebase **hard for an AI agent to degrade**: not
just to detect conventions (the scan) but to *enforce* them through machine-checkable
gates the agent must satisfy before its work verifies or merges. Each row below is one
enforcement module — a distinct thing Harness generates and a distinct tier at which
Nightcore enforces it. This document is the single place that tracks all 18: what each
produces, how it's enforced, its prior art, and — the part §4 lacked — its **current
implementation status** and the concrete seam it hooks into.

The modules are independent but share two foundations, both now shipped:

- **The verify-command gate** (`Task.verify_command`, `gauntlet_project::append_task_verify_command`)
  — a per-task machine-checkable done-command that runs as a Structure-Lock check
  *before* the paid reviewer, folding failures into the existing bounded auto-fix loop.
  This is module #1, and it is the hook every other "gate"-tier module reuses:
  a new gate is a new deterministic check appended to the `StructureLockResult`, routed
  through the same fix/park machinery — no new failure path. Shipped in `5dc786f`.
- **The manifest writer** (`sidecar/harness/apply.rs::write_merge_manifest`,
  `arm_harness_gauntlet_check`) — the previously-missing producer for
  `.nightcore/harness.json`, positive-allowlisted to that one path, Rust-authored
  (never model output), atomic, merge-by-name. This is what lets any gate module
  persist a project-wide check that the zero-cost gauntlet runs on every future task.
  Shipped in `1bb5f93`.

**Enforcement tiers** (strongest last):
`advisory doc` < `meta-lint gate` < `gate` (zero-token, pre-reviewer/pre-merge) <
`runtime hook` (PreToolUse, holds under bypassPermissions) < `OS containment` (sandbox).

**Status legend:** `SHIPPED` · `MECHANISM` (the enforcement seam exists; a producer that
populates it is the remaining work) · `PLANNED`.

## 2. The catalog (ordered by value-for-effort)

### 1. Verify-command contract — `SHIPPED`
The gate everything else leans on: audit/synthesize one fast machine-checkable
done-command (a `verify` script + an AGENTS.md line + a manifest entry). **Tier:** gate.
**Prior art:** Factory.ai agent-readiness; CodeScene agentic patterns.
**Implementation:** `Task.verify_command: Option<String>` (serde-additive; ts-rs →
`Task.ts`); `gauntlet_project::append_task_verify_command` runs it in the review dir and
folds the outcome into the `StructureLockResult`; wired in `verification/handlers.rs`
after the project checks pass; settable via `update_task` (`TaskPatch.verify_command`).
Producer still open: a Harness proposal-convert that *sets* the command on the task that
wires enforcement (see §3).

### 2. Test-integrity anti-gaming sweep — `SHIPPED` (2026-07-02)
Pure-diff detection of `.only`/`.skip`, gutted assertions, new suppressions
(`ts-ignore`/`eslint-disable`), gate-config edits, and `--no-verify` in the session's
Bash history — the ways an agent "passes" by weakening the check rather than the code.
**Tier:** gate (zero-token, pre-reviewer). **Prior art:** Kinney, "Making It Hard to
Cheat the Guardrails." **Implementation:** `workflow/anti_gaming.rs` — pure detectors
over the `merge-base..HEAD` diff (focused/skipped tests incl. `xit`/`test.todo` with
identifier-boundary matching, added `@ts-ignore`/`eslint-disable` (never
`@ts-expect-error`), any hunk touching `.nightcore/`, assertion-gutting = removed
`expect(`/`assert` with none added in a surviving test file). Appends a Failed
`anti-gaming` check with file+pattern evidence into the structure-lock gate → same
fix/park loop; silent on zero findings. Always-on for worktree builds, no manifest
entry; infrastructure failures (no base/git) warn-and-skip, never fail the gate. The
Bash-history `--no-verify` detection is deferred to the #5 flight-recorder ledger — the
runtime hook (#3 `denyBashPatterns`) already denies it live.

### 3. Protected-paths + bypass-flag denial — `SHIPPED`
Manifest-driven PreToolUse rules blocking Edit/Write to lockfiles, migrations, generated
code, and the manifest itself, plus Bash escape hatches. **Tier:** runtime hook, enforced
in Nightcore's seam (never the target repo's `.claude/settings.json`, so it holds under
bypassPermissions). **Prior art:** Claude Code hooks exit-2 semantics; dwarvesf/
claude-guardrails. **Implementation:** `packages/engine/src/policy/harness-policy.ts` — the
THIRD PreToolUse evaluator in `HookBus` (after the destructive deny list + workspace
confinement), enforcing `protectedPaths` (segment-aware globs over Write/Edit/MultiEdit/
NotebookEdit — `*` within a segment, `**` across, floating basename patterns, subtree
protection, case-insensitive) and `denyBashPatterns` (project regexes over the raw Bash
command line, invalid ones warn-and-skipped). `.nightcore/**` is IMPLICITLY protected
whenever the layer is armed so an agent can't edit the config that gates it. The Rust core
reads the `policy` key of `.nightcore/harness.json` (`store/harness_policy.rs::read_policy`,
resolved from the project root the run cwd was pinned to) and carries the effective policy
on `start-session` (`HarnessPolicySchema`, serde-additive); a manifest without a `policy`
key still arms the empty self-protection floor, `policy.enabled:false` is the wholesale
opt-out. Commits `672e522` (core threading) + `6447df0` (engine enforcement) + `345ed2d`
(adversarial-review hardening). **Open follow-ups (from the 3-lens verification, none
blocking):** the worktree-mode Structure-Lock gauntlet reads its manifest from the worktree
dir (where `.nightcore/` is gitignored → absent → skips all checks) while the policy layer
reads from root — a PRE-EXISTING gauntlet parity gap module #3 now makes visible; a task
that legitimately needs a protected-path edit burns the full reviewer+fix budget because
verification is policy-blind (feed the deny signal to an early "blocked-by-policy" park);
a catastrophic-backtracking `denyBashPatterns` regex can stall the single-process sidecar
(trusted config today, but a length cap / re2 guard would close it); and the two-step
symlink write (`ln -s` then Edit through it) defeats the lexical self-protection — the same
documented gap workspace-confinement has, deferred to the OS sandbox (#15).

### 4. Secret hygiene — `SHIPPED` (2026-07-02)
A `.gitleaks.toml` artifact + read-denial of `.env*`/keys via the hook layer + gitleaks
against staged changes in Nightcore's own `commit_task`. **Tier:** hook + gate.
**Prior art:** gitleaks/TruffleHog; Snyk State of Secrets. **Implementation:** all three
parts: (a) `.gitleaks.toml` ships as a `tool-config` create artifact (synthesis playbook
in `scans/harness/reference.ts::hardeningReference`, `secret-scan` armable check kind);
(b) `policy.denyReadPaths` in the manifest → engine read-denial of Read/NotebookRead and
explicitly-pathed Grep/Glob (`harness-policy.ts`, `harness-read-deny` rule; rootless
Grep sweeps are a documented lexical gap — `denyBashPatterns` owns `cat`-style reads);
(c) `workflow/secret_scan.rs` runs `gitleaks protect --staged --no-banner --redact`
between staging and committing in `commit_task_blocking` — fail-closed once gitleaks is
installed (opt-in by install, `which`-probed so gitleaks-less Windows machines don't
misread ToolAbsent as Findings), redacted-tail evidence only.

### 5. Diff budget + session flight recorder — `SHIPPED` (budget) / `PLANNED` (ledger)
Per-task changed-lines/files ceiling (breach *parks for triage*, never hard-fails) over a
persisted tool-event ledger. **Tier:** gate + observability. **Prior art:** Danger JS
`bigPRThreshold`; agent audit-log practice. **Implementation (2026-07-02):**
`workflow/diff_budget.rs` reads `policy.diffBudget { maxChangedLines, maxChangedFiles }`
from the PROJECT root's manifest (a deliberately separate small reader — `.nightcore/`
is gitignored in worktrees) and measures `merge-base..HEAD` in the review dir; a breach
runs BEFORE the gauntlet and parks the task `WaitingApproval` with actuals-vs-budget in
`task.error` — never the auto-fix loop (an agent must not "fix" scope by deleting work).
Worktree builds only. The session flight-recorder ledger remains the open half (the
biggest new surface here).

### 6. Strictness ratchet — `SHIPPED` (2026-07-02)
Baseline snapshot of `any`/`ts-ignore`/`eslint-disable` counts + a never-worse gauntlet
check; agents may reduce debt, never add it. **Tier:** gate. **Prior art:** Betterer;
type-coverage. **Implementation:** `workflow/ratchet.rs` — `.nightcore/ratchet.json`
baseline (atomic temp+rename write, snapshotted via the `snapshot_ratchet_baseline`
command; never auto-tightened) vs a recount of git-tracked `*.ts`/`*.tsx` in the review
dir (`: any`/`as any`/`<any>` with identifier boundaries, `@ts-ignore`,
`eslint-disable`). Regression ⇒ Failed `strictness-ratchet` check naming each counter
(`any: 41 → 44 (+3)`); held ⇒ a visible Passed check; absent baseline ⇒ silent skip.
Runs for both worktree and main-mode builds.

### 7. Import-boundary lock — `SHIPPED` (producer, 2026-07-02)
A `.dependency-cruiser.cjs` + eslint-plugin-boundaries config derived from the profiler's
import graph, human-confirmed. **Tier:** gate (reuses the gauntlet's already-implemented
`dependency-cruiser` check kind). **Prior art:** Xebia fitness functions; Nx boundaries.
**Implementation:** synthesis playbook emits a `tool-config` `.dependency-cruiser.cjs`
— a LIVE `packages-not-into-apps` rule only when the profile observed app+package roles,
commented examples otherwise; depcruise roots derived from observed member dirs — plus
an agent-task installing/wiring it with `verifyCommand: npx depcruise …` and a suggested
`dependency-cruiser` harnessCheck. Arming stays human-gated via
`arm_harness_gauntlet_check`.

### 8. Agent-context budget compiler — `SHIPPED` (advisory, 2026-07-02)
CLAUDE.md/AGENTS.md compiled against an instruction budget (~150 lines), banned-pattern
lint, overflow restructured into satellite docs. **Tier:** advisory doc + meta-lint gate.
**Prior art:** HumanLayer CLAUDE.md guide; GitHub 2,500-repo AGENTS.md analysis.
**Implementation:** the synthesis playbook now compiles every `agent-contract` artifact
against the budget — imperative project-specific rules only, filler and config-derivable
content banned, overflow restructured into linked satellite docs via agent-task. A
deterministic line-count lint (gate tier) remains open; today the budget is enforced at
generation, not re-checked at verify.

### 9. Least-privilege permission manifest — `SHIPPED` (deny tier, 2026-07-02)
A derived deny→ask→allow ruleset emitted as a settings artifact and merged into SDK
`Options` per session. **Tier:** runtime gate — the concrete first step of the LOCKED
tiered-sandbox decision. **Prior art:** Claude Code permissions docs. **Implementation:**
`policy.disallowedTools` (exact SDK tool names, incl. `mcp__server__tool`) resolves from
the manifest and is enforced twice: unioned into SDK `Options.disallowedTools` at
session construction (belt — the SDK enforces it regardless of permission mode) AND
denied at the HookBus PreToolUse evaluator (`harness-tool-deny`, suspenders against SDK
regressions). The fuller derived ask/allow tiers remain open.

### 10. Changed-lines coverage gate — `SHIPPED` (producer, 2026-07-02)
Coverage restricted to the agent's own diff (~80% threshold), uncovered lines fed to the
fix loop. **Tier:** gate. **Prior art:** diff-cover. **Implementation:** the synthesis
playbook emits an agent-task wiring the runner's coverage report + diff-cover
(bun-specific lcov hint included), with `verifyCommand` and a suggested
`coverage-threshold` harnessCheck (`npx diff-cover … --fail-under=80`) — armable,
runnable (the kind was already parsed by the gauntlet).

### 11. Dependency firewall — `SHIPPED` (producer, 2026-07-02)
Install-command interception (allow-from-lockfile), `ignore-scripts`/`save-exact`
configs, a lockfile-lint gauntlet stage, lockfile-changed → park. **Tier:** hook + gate.
**Prior art:** Slopsquatting research (USENIX 2025); lockfile-lint. **Implementation:**
per-package-manager honesty in the playbook: npm/pnpm get a `tool-config` `.npmrc`
(`ignore-scripts=true`, `save-exact=true`); bun skips it (scripts already opt-in via
`trustedDependencies`); yarn routes agent-task (`.yarnrc.yml` usually exists — create
never clobbers). The `lockfile-lint` armable kind runs the real linter for npm/yarn
lockfiles and the truthful frozen-lockfile install for pnpm/bun (lockfile-lint can't
parse those). Install interception ships as a `policy.denyBashPatterns` example in the
proposal DESCRIPTION only — proposals never write policy. Lockfile-changed → the #3
runtime hook already denies lockfile writes when `protectedPaths` lists them.

### 12. Prompt-injection surface scan — `SHIPPED` (2026-07-02)
Deterministic detectors (Unicode tags, zero-width text, instruction-shaped strings) over
repo text pre-flight; flagged paths read-quarantined. **Tier:** scan + hook. **Prior
art:** HiddenLayer CopyPasta; the 84%-ASR research. **Implementation:**
`store/injection_scan.rs` — Unicode tag block (U+E0000–E007F), zero-width RUNS (single
ZWJ/leading BOM tolerated), bidi overrides (trojan-source), and a short high-signal
instruction-phrase list, over git-tracked text files (binary-sniffed, 1 MiB cap),
exposed as the `scan_injection_surface` command. Detection only BY DESIGN: flags are
evidence a human quarantines via `policy.denyReadPaths` (the engine read-deny then
enforces per-session) — a scan auto-writing enforcement config would itself be an
injection target. Complements the shipped `untrusted_block`/`defuse_fence` output
fencing with the input-side sweep.

### 13. Env-var contract — `SHIPPED` (producer, 2026-07-02)
A typed env schema (zod/t3-env style) + a `.env.example` sync check. **Tier:** gate +
grounding doc. **Prior art:** t3-env; Factory readiness. **Implementation:** the
playbook emits a `tool-config` `env.schema.ts` starter listing ONLY variables the scan
saw read, plus an agent-task wiring it at the entry point with an `env:check` script
that fails on `.env.example` drift; the `env-contract` armable kind makes the check a
standing gauntlet gate.

### 14. Ranked repo map for the Context Pack — `PLANNED`
A tree-sitter symbol graph, PageRank-ranked, budgeted into every session's pre-flight
context. **Tier:** advisory grounding. **Prior art:** Aider repomap. **Implementation
note:** feeds the existing Pre-flight Context Pack feature; no enforcement, pure grounding.

### 15. Sandbox profile artifact — `PLANNED`
A per-repo devcontainer + Seatbelt/bubblewrap config. **Tier:** OS containment — the
strongest tier, blocked on the tiered-sandbox roadmap item. **Prior art:** Anthropic
sandbox-runtime.

### 16. Characterization-test bootstrapper — `SHIPPED` (producer, 2026-07-02)
Golden-master tests for high-fan-in/low-coverage modules before agents touch them.
**Tier:** artifact + pre-flight advisory. **Prior art:** Feathers, *Working Effectively
with Legacy Code*. **Implementation:** an evidence-gated agent-task in the playbook —
emitted ONLY when synthesis can NAME concrete modules it actually read (paths + evidence
in the prompt), full skip otherwise; the profile carries no fan-in/coverage metrics yet,
so grounding is prompt discipline until #14-style analysis exists.

### 17. Mutation-score gate-strength audit — `SHIPPED` (producer, 2026-07-02)
Stryker incremental on critical paths; scores how much "tests pass" is worth per module,
feeding the Scorecard Tests dimension. **Tier:** advisory that tunes gates. **Prior art:**
Google mutation-at-scale. **Implementation:** an agent-task in the playbook (Stryker
incremental, scoped `mutate`) + the `mutation-score` armable kind. The
Scorecard-dimension feedback loop remains open.

### 18. Public-API snapshot lock / AST policy pack / commit discipline — `SHIPPED` (commit discipline) / `PLANNED` (rest)
api-extractor surface reports, ast-grep multi-language rules, lefthook+commitlint
bundles. **Tier:** gates, lower priority until the manifest ecosystem is proven.
**Implementation (2026-07-02):** commit discipline ships as agent-task ONLY (lefthook/
husky configs drive git hooks = execution-adjacent), and the trust boundary was hardened
to match: 8 lefthook config basenames added to `apply.rs::DENIED_TARGET_BASENAMES` + the
engine mirror. api-extractor and ast-grep packs remain planned.

## 3. Where the catalog stands (2026-07-02, end of day)

Sixteen of the eighteen modules now have shipped enforcement and/or producers. The
deterministic gate battery in `handle_build_completed` runs, in order: **diff-budget
park gate (#5) → structure-lock manifest checks (#3) → anti-gaming sweep (#2) →
strictness ratchet (#6) → task verify-command (#1)** — all zero-token, all before the
paid reviewer. The runtime hook enforces **protected paths + Bash denial (#3), read
denial (#4/#12), and tool denial (#9)** per session, including under
`bypassPermissions`. `commit_task` is gated by the **staged-changes secret scan (#4c)**.
Synthesis produces the **#4/#7/#10/#11/#13/#16/#17/#18 artifacts and agent-task
proposals** with honest per-stack routing (execution-adjacent targets go agent-task; the
apply denylist gained lefthook basenames), and compiles agent contracts against the
**#8** instruction budget. Seven armable check kinds exist end-to-end
(lint-plugin, dependency-cruiser, coverage-threshold, lockfile-lint, env-contract,
secret-scan, mutation-score).

**Still open, in value order:**
1. **#14 Ranked repo map** — the largest standalone piece (tree-sitter symbol graph +
   PageRank into the Context Pack); nothing else blocks on it, but #16's evidence
   gating would sharpen with its fan-in data.
2. **#15 Sandbox profile artifact** — blocked on the tiered-sandbox roadmap decision;
   it is also the honest fix for every documented lexical gap (symlinks, rootless
   Grep, Bash write vectors).
3. **#5's flight recorder** — the persisted per-run tool-event ledger (also unlocks
   #2's Bash-history detection).
4. **#9's ask/allow tiers** — deny shipped; the derived full ruleset remains.
5. **#18's api-extractor / ast-grep packs** — parked until the manifest ecosystem is
   proven in anger.
6. **A policy-authoring UI** for the `policy` block of `harness.json` (today
   hand-authored or Rust-written) and a UI surface for `scan_injection_surface`
   results → one-click quarantine into `denyReadPaths`.
