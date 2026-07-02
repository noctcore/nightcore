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

### 2. Test-integrity anti-gaming sweep — `PLANNED`
Pure-diff detection of `.only`/`.skip`, gutted assertions, new suppressions
(`ts-ignore`/`eslint-disable`), gate-config edits, and `--no-verify` in the session's
Bash history — the ways an agent "passes" by weakening the check rather than the code.
**Tier:** gate (zero-token, pre-reviewer). **Prior art:** Kinney, "Making It Hard to
Cheat the Guardrails." **Implementation note:** a built-in Rust gauntlet check over the
worktree diff (`base...HEAD`), appended like the verify-command check; evidence fed to
the fix loop via `fix_instruction`. No manifest entry needed (built-in, always-on for
worktree Build tasks).

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

### 4. Secret hygiene — `PLANNED`
A `.gitleaks.toml` artifact + read-denial of `.env*`/keys via the hook layer + gitleaks
against staged changes in Nightcore's own `commit_task`. **Tier:** hook + gate.
**Prior art:** gitleaks/TruffleHog; Snyk State of Secrets. **Implementation note:** the
`.gitleaks.toml` is a safe `create` artifact (already reachable via `apply.rs`); the
staged-diff scan slots into `workflow::merge::commit_task_blocking`; read-denial reuses
module #3's hook.

### 5. Diff budget + session flight recorder — `PLANNED`
Per-task changed-lines/files ceiling (breach *parks for triage*, never hard-fails) over a
persisted tool-event ledger. **Tier:** gate + observability. **Prior art:** Danger JS
`bigPRThreshold`; agent audit-log practice. **Implementation note:** the ceiling is a
gauntlet check over the worktree diff stat; the ledger is a new persisted per-run event
log (the biggest new surface here).

### 6. Strictness ratchet — `PLANNED`
Baseline snapshot of `any`/`ts-ignore`/`eslint-disable` counts + a never-worse gauntlet
check; agents may reduce debt, never add it. **Tier:** gate. **Prior art:** Betterer;
type-coverage. **Implementation note:** a baseline file (`.nightcore/ratchet.json`,
written by the same allowlisted manifest-writer pattern) + a built-in check comparing
current counts to baseline over the diff.

### 7. Import-boundary lock — `PLANNED`
A `.dependency-cruiser.cjs` + eslint-plugin-boundaries config derived from the profiler's
import graph, human-confirmed. **Tier:** gate (reuses the gauntlet's already-implemented
`dependency-cruiser` check kind — reachable for the first time now that the writer can
arm it). **Prior art:** Xebia fitness functions; Nx boundaries. **Implementation note:**
the config is a `create` artifact; arming `npx depcruise src` via `arm_harness_gauntlet_check`
makes it live.

### 8. Agent-context budget compiler — `PLANNED`
CLAUDE.md/AGENTS.md compiled against an instruction budget (~150 lines), banned-pattern
lint, overflow restructured into satellite docs. **Tier:** advisory doc + meta-lint gate.
**Prior art:** HumanLayer CLAUDE.md guide; GitHub 2,500-repo AGENTS.md analysis.
**Implementation note:** an `agent-contract` artifact (merge-section, already supported) +
a lint-meta rule.

### 9. Least-privilege permission manifest — `PLANNED`
A derived deny→ask→allow ruleset emitted as a settings artifact and merged into SDK
`Options` per session. **Tier:** runtime gate — the concrete first step of the LOCKED
tiered-sandbox decision. **Prior art:** Claude Code permissions docs. **Implementation
note:** consumes the same manifest; applied at session construction, not the target
repo's settings.

### 10. Changed-lines coverage gate — `PLANNED`
Coverage restricted to the agent's own diff (~80% threshold), uncovered lines fed to the
fix loop. **Tier:** gate. **Prior art:** diff-cover. **Implementation note:** a manifest
`coverage-threshold` check (kind already parsed by the gauntlet) whose command runs
diff-cover; armable today via the writer.

### 11. Dependency firewall — `PLANNED`
Install-command interception (allow-from-lockfile), `ignore-scripts`/`save-exact`
configs, a lockfile-lint gauntlet stage, lockfile-changed → park. **Tier:** hook + gate.
**Prior art:** Slopsquatting research (USENIX 2025); lockfile-lint. **Implementation
note:** the configs are `create` artifacts; install interception reuses module #3's Bash
hook; lockfile-lint is an armable check.

### 12. Prompt-injection surface scan — `PLANNED`
Deterministic detectors (Unicode tags, zero-width text, instruction-shaped strings) over
repo text pre-flight; flagged paths read-quarantined. **Tier:** scan + hook. **Prior
art:** HiddenLayer CopyPasta; the 84%-ASR research. **Implementation note:** complements
the already-shipped `untrusted_block`/`defuse_fence` output fencing with an *input*
pre-flight scan; quarantine reuses module #3's read-deny.

### 13. Env-var contract — `PLANNED`
A typed env schema (zod/t3-env style) + a `.env.example` sync check. **Tier:** gate +
grounding doc. **Prior art:** t3-env; Factory readiness. **Implementation note:** schema
is a `create` artifact; the sync check is a built-in gauntlet check.

### 14. Ranked repo map for the Context Pack — `PLANNED`
A tree-sitter symbol graph, PageRank-ranked, budgeted into every session's pre-flight
context. **Tier:** advisory grounding. **Prior art:** Aider repomap. **Implementation
note:** feeds the existing Pre-flight Context Pack feature; no enforcement, pure grounding.

### 15. Sandbox profile artifact — `PLANNED`
A per-repo devcontainer + Seatbelt/bubblewrap config. **Tier:** OS containment — the
strongest tier, blocked on the tiered-sandbox roadmap item. **Prior art:** Anthropic
sandbox-runtime.

### 16. Characterization-test bootstrapper — `PLANNED`
Golden-master tests for high-fan-in/low-coverage modules before agents touch them.
**Tier:** artifact + pre-flight advisory. **Prior art:** Feathers, *Working Effectively
with Legacy Code*.

### 17. Mutation-score gate-strength audit — `PLANNED`
Stryker incremental on critical paths; scores how much "tests pass" is worth per module,
feeding the Scorecard Tests dimension. **Tier:** advisory that tunes gates. **Prior art:**
Google mutation-at-scale.

### 18. Public-API snapshot lock / AST policy pack / commit discipline — `PLANNED`
api-extractor surface reports, ast-grep multi-language rules, lefthook+commitlint
bundles. **Tier:** gates, lower priority until the manifest ecosystem is proven.

## 3. The critical path to the next modules

The two shipped foundations mean modules **7, 10, 11 (armable checks)** are now reachable
with *only* a producer (a `create` artifact + one `arm_harness_gauntlet_check` call), and
modules **2, 5, 6, 13 (built-in gates)** need only a new Rust check appended like
`append_task_verify_command`. The single highest-leverage next producer is the **Harness
proposal-convert** (review §3 phase 3): synthesis emits a task-shaped proposal carrying a
`verifyCommand`, and converting it mints a Build task with `verify_command` pre-set — so
wiring an ESLint plugin into `eslint.config.*` becomes a worktree agent task gated by
`npx eslint .`, and on verify the manifest is armed. That closes the "inert ESLint plugin"
gap end-to-end using only mechanisms that now exist.

**Runtime-hook modules (4, 9, 11, 12)** waited on one shared piece: a
`harness-policy.ts` PreToolUse layer in Nightcore's seam, driven by the codegen'd
manifest. That layer is now **SHIPPED** (module #3 above), so those four are unlocked:
- **#4 Secret hygiene** — read-denial of `.env*`/keys reuses the protected-paths/Bash-deny
  seam; the `.gitleaks.toml` is a `create` artifact + a `commit_task` staged-diff scan.
- **#9 Least-privilege permission manifest** — a derived deny→ask→allow ruleset; the hook
  now demonstrates manifest→session-policy plumbing to copy.
- **#11 Dependency firewall** — install-command interception is a `denyBashPatterns` entry
  today; `ignore-scripts`/`save-exact` configs are `create` artifacts; lockfile-lint is an
  armable check.
- **#12 Prompt-injection surface scan** — flagged paths become `protectedPaths`/read-deny
  entries once the input pre-flight scan exists.
The next producer to build is still the **Harness proposal-convert that sets a
`verifyCommand`** (§3 above) plus a UI to author the `policy` block of `harness.json`
(today it is hand-authored or Rust-written); with the hook shipped, the remaining hook-tier
work is populating the manifest, not new enforcement infrastructure.
