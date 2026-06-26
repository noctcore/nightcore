# Nightcore Roadmap — From Task Runner to Governed Skill/Agent Control Panel

*2026-06-26 — comparative analysis vs Aperant + Automaker + the Claude Code skills/agents ecosystem.*

> **Method.** 14-agent ultracode workflow: 9 parallel deep-readers (nightcore arch / engine-SDK /
> features / security / UI, Aperant, Automaker, the skills ecosystem, existing docs) → 4 cross-cutting
> synthesizers (production-enterprise, security/AI-harness, UI/UX, skills-as-control-plane) → 1 roadmap
> architect. The Rust orchestration-core reliability pass was re-run standalone (the first attempt
> misfired) and is folded in below. Aperant + Automaker were used **only** as UI/UX and
> production-maturity references, per the request.

---

## North Star

Nightcore becomes the **operator console for the installed Claude Code skill/agent ecosystem** — the
place an external developer dispatches `ship`, `add-feature`, `kirei`, the `reviewer-*` fan-out, and the
`commit→open-pr→release` pipeline as first-class board work, watches every agent's diff/cost/progress
in-app, and trusts it because each autonomous run is *contained* (OS-sandboxed, worktree-scoped,
trust-gated), *observable* (out-of-tree audit log, persisted token ledger), *reversible* (file
checkpointing, denied destructive git, per-artifact undo), and *governed* (enforced
budget/turn/concurrency ceilings, granular permission grammar). It stays local-first and single-user —
"team" means shared-git affordances (committed project memory, findings export), not a multi-tenant
server — and it ships as a signed, auto-updating binary an outside developer can install and adopt as
their daily dev control panel.

## Where Nightcore stands today

Nightcore is engineered well above v0: a dual-codegen contract spine, a quarantined SDK boundary, boot
reconciliation that re-queues stranded work, atomic poisoned-lock-recovering stores, exemplary
non-forcing git primitives (`safe_join` / `apply_harness_artifact` / base-confined worktrees), an honest
Config→Running→Results lifecycle UX with real focus-trapped a11y, and 696 green tests. But four gaps
dominate:

1. **The agent is uncontained by default** — no OS sandbox, default `bypassPermissions` running in the
   *project root* (not even a worktree), wholesale `process.env` spread, empty deny list, and target-repo
   `CLAUDE.md`/skills auto-loaded into the autonomous session: a single Bash turn has whole-machine reach
   via a wide-open prompt-injection → RCE path.
2. **The safety/observability/governance machinery is built but inert** — budget knobs hardcoded to
   `None`, full token-usage breakdown computed then dropped at the Rust boundary, `mapAssistantError`
   dead code with no retry/backoff, no audit trail.
3. **It can *see* the skill ecosystem but can't *dispatch as* one** — `TaskKind` is a closed 4-value
   enum, prompts are bare `title+description`, never `/skill …`.
4. **Zero release machinery** — no CI, no commit hooks, version pinned at `0.0.0`, no signing/updater,
   and an external dev who clicks Insight first hits a literal dead-end empty state.

---

## Findings by dimension

### A. Security & AI-harness guardrails — the gating dimension

The codebase is split-personality: the **file-write and git primitives are production-grade**
(`safe_join` does lexical `..` rejection → `lstat` symlink-walk → canonical containment → `create_new`
no-clobber; worktree remove/merge refuse anything outside base and never `--force`), while the **agent
process itself is effectively uncontained by default**. The carefully-built fail-closed `canUseTool`
permission layer is **never reached** under `bypassPermissions`, so blast radius = the whole machine.

Two **CRITICAL** blockers to any "enterprise-ready" claim:

- **No OS sandbox + default bypass in the project root.** One agent turn can `rm -rf ~`, read
  `~/.ssh`/`~/.claude`, or exfiltrate via `curl`/WebFetch — no approval, no worktree confinement. The
  default `run_mode=main` runs in the project *root*; `Options.env` spreads `process.env` wholesale
  (`session-runner.ts:556`).
- **Prompt-injection → RCE, wide open.** Default `settingSources:['user','project','local']` loads the
  target repo's `CLAUDE.md` + `.claude/` skills into the build agent. A malicious/compromised repo (or
  any WebFetched content) becomes untrusted *instructions* with whole-machine reach. There is no
  workspace-trust gate.

High-leverage hardening (M-or-smaller, ships before the XL sandbox):

- **Workspace-trust gate** (VS Code model): untrusted repo ⇒ worktree + non-bypass (ask/plan) + strip
  `project`/`local` settingSources + WebFetch off; flip to bypass only on explicit trust.
- **Safe default Bash/Write deny list** unioned into `disallowedTools` (`rm -rf`, `sudo`, `curl|sh`,
  `git push --force`, `reset --hard`) so it bites *even under bypass*.
- **Promote the PreToolUse hook to a blocking enforcement gate.** `HookBus.hooks()` returns
  `{continue:true}` with zero consumers today, yet SDK hooks fire **regardless of permissionMode** — the
  one seam that contains a bypass session using infrastructure that already exists.
- **Append-only, out-of-tree, hash-chained audit log** of `tool-use-requested` events. The stream
  already carries Bash cmd / Write path / WebFetch URL / who-what-when; today's only record lives
  *inside* the agent's own writable tree (self-falsifiable).
- **Supply chain:** checksum-verify the bundled sidecar before spawn; pin/verify the resolved `claude`
  hash and drop PATH/world-known-location fallbacks; MCP allowlist + consent gate (a stdio MCP entry is
  arbitrary local exec by design); fix the Windows `0600` no-op on MCP secrets and move them to OS
  keychain.
- **Reversibility for the agent:** deny destructive git verbs, enable `enableFileCheckpointing` +
  rewind, add per-artifact Harness undo with a merge-diff preview.
- **Cost/runaway:** default `maxBudgetUsd` ceiling + revive `mapAssistantError` + bounded backoff for
  `rate_limit`/`overloaded`.

> **Genuine strengths to preserve and propagate as the bar:** `safe_join`/`apply_harness_artifact`,
> base-confined non-forcing worktrees, the zero-token gauntlet, the no-broker credential model (never
> passes an `apiKey`; only tracks a presence boolean), and the fail-closed `canUseTool` layer — which
> only needs to actually be *reached* to do its job.

### B. Nightcore as the skills/agent control panel — the differentiator

The host plumbing to *run* the ecosystem already exists: `session-runner.baseOptions()` sets
`settingSources` and `skills:'all'`, and `supportedCommands()`/`supportedAgents()` already enumerate the
installed skills into `contracts/provider-config.ts`. The board can *see* the ecosystem; it just can't
*dispatch a card as* a skill. The crucial existing asset is the **two-half preset seam**: `workflow/kind.rs`
owns orchestration policy (`allocate_worktree`/`verify_after`/`writes_code`) and
`packages/engine/src/kind-presets.ts` owns the agent definition
(`appendSystemPrompt`/`allowedTools`/`permissionMode`) — every ecosystem skill maps cleanly onto exactly
these two axes.

Top control-plane moves:

1. **Open the `TaskKind` enum into a skill-backed registry + `skill: Option<String>` on `Task`;** dispatch
   as `/<skill> <body> [mode=…]`. Registry keyed by skill id carries
   `writes_code`/`verify_after`/`allocate_worktree`/tools, seeded from the inspector so unknown/user
   skills appear with a safe default. **The keystone — nothing else dispatches without it.**
2. **`SkillPicker`** fed by the provider-config inspector, grouped **Orchestrators** (`ship`,`kirei`) ·
   **Core** (`add-feature`/`modify-feature`/`fix-bug`/`remove-feature`/`audit`/`realign`) · **Quality**
   (`harden-types`/`simplify`/`write-tests`/`polish-ui`/`impeccable`) · **Pipeline**
   (`commit`/`open-pr`/`release`), with a `mode=fast|balanced|production` + `include=`/`skip=` passthrough.
3. **Generalize `verification.rs` into a generic `Stage[]` pipeline runner** with `.nightcore/tasks/<id>/`
   artifact handoffs; model `ship` and `kirei` as templates. The kirei `HANDOFF` doc becomes the explicit
   between-stage contract; the existing bounded auto-fix loop + park-for-approval become reusable stage
   outcomes.
4. **Reviewer-* fan-out gate** (a kirei-chain over one diff): launch N read-only reviewers concurrently
   over the same worktree, lens-selected by touched paths (auth/payments/migrations ⇒
   `reviewer-authz`+`reviewer-security-regression`+`reviewer-data-integrity`), conflict-surfaced before
   the single verdict. The slot pool already runs N concurrent leased sessions.
5. **Commit→PR→release ship lane** dispatching
   `commit-and-push`→`check-pr-readiness`→`open-pr`→`check-release-risk`→`release` from a `gh`-capable
   **project-root** session (a new non-worktree run mode), with the risk briefing surfaced in
   `ReviewPanel`. Today the terminal action is a *local* merge — grep confirms no `git push`/`gh`/PR path
   anywhere. **The single biggest production-bar closure.**
6. **Persist token-usage end-to-end + live cost/agents-in-flight HUD + UI budget ceilings.** The SDK
   adapter already emits the usage breakdown and `subagentType`/status; it's dropped at
   `session-manager.ts:496`. Almost entirely a persistence + UI gap, not an SDK gap.
7. **Wire the reserved `decompose` kind to a real backlog producer** (`/add-feature` plan / `kirei-audit`
   scout → NDJSON subtasks+edges → `create_task`+`dependencies`, plan-gated). The missing front door to
   the autonomous loop — zero coordinator change, it already reads the graph this would write.
8. **Schema-constrain the gate via SDK `outputFormat:{json_schema}`** + run the deterministic gauntlet as
   a pre-filter before the paid reviewer (today the M4 gate dispatches an expensive Claude reviewer even
   on builds that don't compile).

### C. UI/UX for external developers — references: Aperant + Automaker only

Nightcore is internally disciplined (folder-per-component, real ErrorBoundary, focus-trapped modals,
honest optimistic UI, `aria-live` lifecycle, `prefers-reduced-motion`) but reads as a tool built *by* its
author *for* its author. The gap is honesty, discoverability, and legibility of agent activity — not
polish. **Aperant** is the design-system + trust reference; **Automaker** is the surface reference
(diff/terminal/graph/chat/usage).

1. **Working-tree-aware git diff viewer on the approval state** (Automaker `codemirror-diff-view` +
   `git-utils/diff.ts`: `git diff HEAD` + `status --porcelain` + synthesized untracked, mapped to
   Nightcore's Shiki tokens). There is **no surface to read what an agent changed** before approving today,
   and the reviewer judges a committed range while the build leaves uncommitted edits (the documented
   `base...HEAD` reviewer bug). **The single highest-value add — M / very high.**
2. **Wire the global hotkey layer + `cmdk` palette behind the existing P/K/I/H/S/N chips.** The sidebar
   advertises these keys but a repo-wide search finds **no global keydown handler** — they do nothing. Port
   Automaker's `isInputFocused()` guard (the focus-guard is the hard part). Silently-failing advertised
   affordances are the fastest trust-eroder.
3. **Promote ~270 arbitrary px literals into a `--text-*` + spacing + shadow scale in `@theme`** and
   codemod onto it (`text-[10px]`×79, `text-[11px]`×49, `text-[9.5px]`×11, plus `text-[8px]`; sub-10px mono
   labels are below accessible reading size), then lint-ban new arbitrary font sizes in the
   `@nightcore/eslint-plugin`. Aperant's `.design-system/` role-token ramp is the gold seam.
4. **Surface cost/turn/concurrency controls + a usage dashboard** (Automaker `usage-types`), threading the
   already-existing-but-hardcoded-`None` budget fields into RunControls with a pre-spend estimate.
5. **Empty-state parity + first-run routing to Projects + a first-run risk-acknowledgment gate**
   (Automaker `sandbox-risk-dialog`). Insight/Harness render *dead-end* empty states with no action; a
   newcomer who clicks Insight first is told "Open a project" with no way to do so. Nightcore runs Claude
   against the host FS with zero acknowledgment today.
6. **Follow-up message queue to steer a live agent** (Automaker `queue-display`) on board cards — removes
   the kill-and-restart penalty for a slightly-off run.
7. **Restructure `--nc-*` into role tokens + a default cosmic-dark skin, then port `useTheme`** (Aperant
   4-way cascade + validate-and-fallback). Pure refactor now; unlocks light/accent/high-contrast as
   CSS-only additions and guards against a deleted-theme white-screen. Ship a *curated* 3–4 themes, not
   Automaker's 40.
8. **Strip internal jargon and gate non-functional surfaces** — the dead M2-badged Default-model/Concurrency
   fields New-Project discards `onCreate`, the fake hardcoded `~/.nightcore`/`~/dev/nightcore` paths, the
   "soon/later" badges. Cheapest way to look honest to an external evaluator.

> Items 1, 4, 6 + the first-run gate (5) + a real per-task session view form one **"trust & legibility of
> autonomous agent activity"** cluster — ship them together, because each alone only half-answers "what is
> the agent doing and how do I intervene?"

### D. Production & enterprise readiness

The recurring theme is *expose and enforce what's already half-built*, not *invent new subsystems*.

- **Reliability:** Strong on *deterministic* failure (boot reconciliation re-queues stranded
  `InProgress`/`Verifying`; `InsightStore::reap_running`; degrade-not-throw end-to-end; atomic stores +
  poisoned-lock recovery; circuit breaker). Weak on *transient* failure: `mapAssistantError` is dead code,
  no retry/backoff anywhere, so a transient `rate_limit`/`overloaded` becomes a hard `session-failed`. The
  highest-risk uncovered surface: **no automated test exercises the real 3-tier runtime** (every suite
  stubs `query()`) — wire a headless smoke run via `dogfood:engine` into CI.
- **Observability:** Telemetry computed then discarded. `session-completed` carries a full usage breakdown
  but only `costUsd` is persisted. No project-level run history, no cost/throughput dashboard, no
  crash/error reporting (add Sentry for Rust core + web shell).
- **Distribution:** App version is `0.0.0`; no signing, notarization, checksum, or updater. A complete
  plan already exists (`2026-06-21-auto-update-system.md`: minisign-signed updates, `tauri-action` matrix).
  Aperant's `release.yml` is the gold trust bar: per-arch notarize+staple, post-sign checksum regen,
  updater-manifest validation, *post-publish* VirusTotal. Also fix the Windows bare `bun`/`npm` shim spawns
  in `gauntlet.rs` via `platform::resolve_program`.
- **CI/CD:** No CI, no commit hooks. Adopt Aperant's `ci-complete` aggregator job (3-OS matrix, Bun+Rust
  caching), worktree-aware pre-commit + conventional commit-msg hooks (the `core.worktree` self-heal
  directly defends the cross-worktree file-leak bug Nightcore's heavy worktree use is exposed to), secret
  scanning (gitleaks) with `.secretsignore`, and a CHANGELOG-gated release.
- **Team path — confirm the lock.** True multi-tenancy contradicts the local-first posture and is a
  different product. The right "team" investment is **shared-artifact affordances on top of git**:
  committed project memory (`.nightcore/memory/*.md` auto-injected, in-app editor — Automaker `context-view`),
  findings/harness export to markdown/issue, named AI profiles, OS-keychain MCP secrets.

### E. Rust orchestration core — reliability (file-grounded)

The M2 core has **excellent fundamentals**: zero `unwrap()`/`panic!` in production paths, atomic temp-file
+ rename persistence with per-id nonce guards, `lock_or_recover` poison recovery, thorough boot
reconciliation, single-lock read-modify-write that fixes the M1 clobber bug, atomic slot leasing, pure
testable deps/breaker logic, and comprehensive structured tracing with no secret leaks. Concrete gaps for
the roadmap's reliability bucket:

| # | Gap | Sev | Evidence |
|---|-----|-----|----------|
| 1 | **Session↔task FIFO desync has no recovery** — a correlation miss logs a warning and drops the event; the stranded sidecar session holds a slot forever → eventual capacity exhaustion / loop hang | HIGH | `provider.rs:367-378` |
| 2 | **Lease→mark-InProgress crash window** — core crash between `try_lease` (`394`) and mark-InProgress (`423`) leaks a slot and leaves the task `Backlog`; boot reconciliation only catches `InProgress`/`Verifying`. Fix: persist the lease in an `active_slots` file, release orphans on boot | HIGH | `coordinator.rs:384-473` |
| 3 | **Worktree-allocation git-lock retry capped by attempt count, not elapsed time** (max 5 × 50ms·n ≈ 1.25s); burst contention drops legit launches | MED | `worktree.rs:117-138` |
| 4 | **Fixed 20s query RPC timeout** — large-codebase analysis/harness scans time out spuriously on slow machines; late reply after eviction is a stale send | MED | `provider.rs:45,702-712` |
| 5 | **Loop can't distinguish "all done" from "all stuck"** — `free_slots()==0` returns silently; `nc:loop` emits "drained"/"running" with no "all-leased-waiting" state. All tasks hung on a missing permission ⇒ board shows "running" | MED | `coordinator.rs:332-359` |
| 6 | **Resume session id never validated/TTL'd** — a months-old persisted SDK UUID is forwarded as `resumeSessionId` unconditionally; no observability that a resume failed | MED | `reader.rs:194-200`, `provider.rs:551-553` |
| 7 | **Scale ceiling unowned** — every tick does `store.list()` + O(n log n) eligible-task filter/sort; at thousands of tasks this is observable latency. No `list(eligible=true)` predicate or cached generation counter | MED | `coordinator.rs:338`, `deps.rs:42-59` |

---

## The Roadmap

### Now (next 2–4 weeks) — foundational, highest-leverage, and CRITICAL security

| Initiative | Why (impact) | Effort | Dimension | Depends on |
|---|---|---|---|---|
| **Workspace-trust gate** (untrusted ⇒ worktree + non-bypass ask/plan + strip `project`/`local` settingSources + WebFetch off; bypass only on explicit trust) | Closes the CRITICAL prompt-injection→RCE chain; cheapest large cut to blast radius | M | Security | — |
| **Stop default `main`+bypass in project root; stop wholesale `process.env` spread; ship a safe default Bash/Write deny list** (unioned into `disallowedTools`, bites under bypass) | Same-day stopgap shrinking blast radius before the full sandbox lands | S–M | Security | — |
| **Surface budget/turn/concurrency caps in RunControls + default `maxBudgetUsd` ceiling** (thread the hardcoded-`None` fields) | Closes uncapped paid autonomous spend; near-zero new code | M | Production/Cost | — |
| **Persist the token-usage breakdown end-to-end** (`SessionRecord.usage` + `handleEvent` + `reader.rs`) | Engine already emits it; unlocks cost ledger, cache telemetry, the HUD | S | Observability | — |
| **Minimal CI gate on main** (3-OS matrix, Bun+Rust caching, single `ci-complete` aggregator; Aperant pattern) | Mechanizes the 696-test discipline currently held by manual habit | M | CI/CD | — |
| **Worktree-aware pre-commit + conventional commit-msg hooks** (`.husky`, `core.worktree` self-heal) | Defends the cross-worktree file-leak bug Nightcore's worktree use is exposed to | M | CI/CD | — |
| **Empty-state parity + first-run routing to Projects + first-run risk-acknowledgment gate** | Removes literal dead-ends; makes first contact with an unsandboxed agent legible + consented | S | UI/UX | — |
| **Transient retry/backoff + revive `mapAssistantError`** on the assistant-error path | Recovers mid-turn rate-limit/overloaded so the autonomous loop survives load | M | Reliability | — |
| **Append-only, out-of-tree audit log** of `tool-use-requested` events (hash-chain optional) | The events exist; today's only record lives inside the agent's writable tree | M | Security/Audit | usage-persist plumbing |
| **Fix FIFO-desync + lease-crash-window slot leaks** (core gaps E1, E2) | Prevents silent capacity exhaustion / stuck loop under crash turbulence | M | Reliability | — |

### Next (1–3 months) — the differentiated control plane + trust surfaces

| Initiative | Why (impact) | Effort | Dimension | Depends on |
|---|---|---|---|---|
| **Skill-backed registry + `skill: Option<String>` on `Task`; dispatch as `/<skill> <body> mode=…`** | THE keystone — nothing else dispatches the ecosystem | L | Control-plane | — |
| **`SkillPicker`** fed by the inspector, grouped Orchestrators/Core/Quality/Pipeline, `mode`/`include`/`skip` passthrough | Makes the registry operable; exposes the depth knob the skills are built around | M | Control-plane/UI | Skill registry |
| **Working-tree-aware git diff viewer on the approval state** (Automaker `codemirror-diff-view`) | Biggest "control panel" gap — read agent changes before approving; fixes the committed-vs-working-tree reviewer bug | M | UI/Trust | — |
| **PreToolUse hook promoted to a real blocking enforcement gate** | The one defense-in-depth seam that contains a `bypassPermissions` session, using infra that exists | M | Security | deny list |
| **Granular permission grammar** (`Bash(rm:*)`, path-scoped Write, `WebFetch(domain:*)`) | Replaces coarse name-only policy with Claude Code's own rule grammar | M | Security | PreToolUse gate |
| **Generalize `verification.rs` into a generic `Stage[]` pipeline runner** with `.nightcore/tasks/<id>/` handoffs; `ship`/`kirei` as templates | Backbone for kirei research→build and the ship lane | L | Control-plane | Skill registry |
| **Reviewer-* fan-out gate** (N reviewers over one diff, lens-selected by touched paths, conflict-surfaced) | Turns a single-lens gate into the ecosystem's graded review | L | Control-plane | Stage runner |
| **Schema-constrain the gate via SDK `outputFormat` + run the gauntlet as a pre-filter** | Removes the fragile free-text verdict grep; stops burning a reviewer on builds that don't compile | M | Control-plane/Cost | Stage runner |
| **Live cost/agents-in-flight HUD + subagent progress tree in `TaskDetail`** | Makes a `/ship` or fan-out legible; data already on the wire | M | UI/Observability | usage-persist |
| **Follow-up message queue to steer a live agent** (Automaker `queue-display`) | Removes the kill-and-restart penalty | M | UI/UX | — |
| **Type/spacing/shadow scale in `@theme` + codemod ~270 px literals; lint-ban new arbitrary sizes** | Readable floor, density lever, design-system maturity | L | UI/UX | — |
| **Global hotkey layer + `cmdk` palette behind the P/K/I/H/S/N chips** (port Automaker's `isInputFocused()`) | Advertised-but-dead shortcuts are the fastest trust-eroder | M | UI/UX | — |
| **OS-keychain MCP secrets + MCP allowlist/consent gate + fix Windows `0600` no-op** | Plaintext MCP secrets + arbitrary-local-exec entries are a pre-prompt RCE / shared-secret gap | M | Security | — |
| **Wire reserved `decompose` kind to a real backlog producer** (NDJSON subtasks+edges → `create_task`, plan-gated) | The missing front door to the autonomous loop; zero coordinator change | M | Control-plane | Skill registry |

### Later (3–6 months) — enterprise, scale, distribution, team-via-git

| Initiative | Why (impact) | Effort | Dimension | Depends on |
|---|---|---|---|---|
| **OS sandbox per run** (disposable container: worktree-only writable FS, default-deny egress + allowlist, drop parent env; `sandbox-exec`/`landlock`+`seccomp` fallback) | The CRITICAL containment fix — what makes "autonomous + bypass" defensible | XL | Security | trust gate, deny list |
| **Commit→PR→release ship lane** (`commit-and-push`→`check-pr-readiness`→`open-pr`→`check-release-risk`→`release` from a `gh`-capable project-root session; risk briefing in `ReviewPanel`) | Converts a local merge into a real ship pipeline — biggest production closure; needs a new non-worktree run mode | XL | Control-plane | Stage runner, gh session mode |
| **Semver bump + signed/notarized/checksummed Tauri auto-update pipeline** (plan written; Aperant `release.yml` bar; post-publish VirusTotal) | The gate to "external developers can install and trust the binary" | L | Distribution | CI gate |
| **Sidecar checksum-manifest verify-before-spawn + pin/verify resolved `claude` hash; drop PATH/global fallbacks** | Converts three pre-prompt RCE vectors into verified-or-refused | M | Security | — |
| **File checkpointing for autonomous runs + rewind + per-artifact Harness undo with merge-diff preview** | Reversibility against the actor most likely to cause harm — the agent itself | M | Security/UI | diff viewer |
| **Per-task/project/day spend caps that pause the auto-loop** | Pre-spend ceiling on top of the post-spend ledger | M | Cost governance | usage-persist, RunControls caps |
| **Committed project memory** (`.nightcore/memory/*.md` auto-injected, in-app editor) **+ findings/harness export + named AI profiles** | The right "team" investment without multi-tenancy | M | Team-via-git | — |
| **Real 3-tier E2E smoke run in CI** via the `dogfood:engine` harness | Covers the highest-risk surface every other suite stubs | M | Reliability | CI gate |
| **Scale-ceiling work**: compact serialization + transcript tail-read + board/timeline virtualization + read-only dagre dependency-graph view (Automaker `use-graph-layout`); `list(eligible=true)` predicate (core gap E7) | Stops "small" being an implicit assumption | S–M + M | Scale | — |
| **Role-token restructure + `useTheme` + curated 3–4 themes + light/high-contrast appearance** | Theming as CSS-only additions; deleted-theme white-screen guard; a11y for bright environments | M | UI/UX | type/spacing scale |
| **Crash/error reporting** (Sentry: Rust core + web shell) | No crash story today beyond grepping the log | M | Observability | — |
| **Query RPC + loop-state observability** (configurable timeout, "all-leased-waiting" loop state, resume-id validation — core gaps E3–E6) | Removes spurious analysis timeouts + the "all done vs all stuck" ambiguity | S–M | Reliability/Observability | — |

---

## Critical-path callouts

Skip these and the honest posture stays *"hardened file-write primitives wrapped around an uncontained agent."*

1. **OS sandbox + no default bypass-in-project-root.** Until each run is OS-contained (or at minimum
   worktree-scoped, non-bypass, env-stripped), one agent turn can `rm -rf ~`, read `~/.ssh`/`~/.claude`, or
   exfiltrate via `curl`. This is the headline CRITICAL gap *and it is the default config.*
2. **Workspace-trust gate.** Without it, target-repo `CLAUDE.md`/skills auto-load into the autonomous
   bypass session — untrusted *input* becomes untrusted *instructions* with whole-machine reach. Ship this
   *before* the sandbox; it's the cheapest large cut.
3. **Out-of-tree, append-only audit log + enforced PreToolUse gate.** No tamper-evident who/what/when fails
   any enterprise audit, and the only record today is inside the agent's own writable tree. The PreToolUse
   gate is the only thing that contains a bypass session today.
4. **Governance that actually bites:** default budget ceiling + surfaced caps + persisted usage ledger. A
   9-category scan opening 6 paid subprocesses at 40 turns with no UI cap is a cost-DoS waiting for a wedged
   or injected agent.
5. **CI gate + semver + signed auto-update.** Nothing mechanically prevents a red baseline landing on main,
   and `0.0.0` unsigned artifacts are an install-trust gap the moment a binary ships externally.

## Quick wins (S-effort, do first)

1. **Persist the token-usage breakdown end-to-end** — dropped at `session-manager.ts:496`. Pure plumbing;
   unlocks the entire cost/HUD story.
2. **Empty-state parity + first-run routing to Projects** — `EmptyState` already supports `action`; pass it
   into Insight/Harness/Board uniformly; route to Projects when zero projects exist (one line in `useRouting`).
3. **First-run risk-acknowledgment gate** — Automaker `sandbox-risk-dialog`; Nightcore runs Claude against
   the host FS with zero acknowledgment today.
4. **Safe default Bash/Write deny list** unioned into `disallowedTools` (`rm -rf`, `sudo`, `curl|sh`,
   `git push --force`, `reset --hard`) — bites even under bypass.
5. **Stop spreading `process.env` wholesale** into the subprocess (`session-runner.ts:556`).
6. **Honor `task_id` in `list_task_sessions`** (`sessions.rs:134` ignores it) — the per-task "session
   history" trust artifact is currently project-wide and wrong.
7. **Strip dead/jargon UI** — the M2-badged Default-model/Concurrency fields `onCreate` discards, the fake
   hardcoded `~/.nightcore`/`~/dev/nightcore` paths, the "soon/later" badges.
8. **`mode=fast|balanced|production` passthrough** once the dispatcher emits slash-commands.

## Decisions (2026-06-26)

These were confirmed with the user and now constrain the roadmap above:

1. **Sandbox = tiered.** Ship the cheap **workspace-trust gate + worktree-scoping + deny list now**;
   reserve the full **OS sandbox for an explicit "untrusted repo" mode later**. Keeps the local-first
   "inherits your local `~/.claude`" simplicity. *Implication:* the "Now" trust-gate/deny-list items are
   confirmed foundational; the XL OS sandbox stays in "Later" and is gated behind untrusted-repo mode
   rather than being an always-on prereq.
2. **Skills seed order = Core workflows first.** `add-feature` / `fix-bug` / `modify-feature` / `audit`
   are wired first (lowest risk, proves the registry), *then* the Pipeline (`commit`→`open-pr`→`release`),
   *then* the Orchestrators (`ship`/`kirei`), *then* Quality skills. *Implication:* the skill registry +
   `SkillPicker` (Next) lands seeded with the Core group; `ship`/`kirei` orchestrators are deliberately
   not the first demo.
3. **Pipelines = first-class board nodes.** Nightcore **models each stage and each fan-out reviewer as a
   distinct, resumable, visible node** — the full "control panel" promise. *Implication:* the `Stage[]`
   runner and reviewer-fan-out are confirmed **L-effort first-class builds**, not thin opaque wrappers;
   budget the streaming/persistence plumbing accordingly.
4. **Team = single-user, invest in team-via-git.** No multi-tenant server tier. The "team" budget goes to
   **committed project memory (`.nightcore/memory/*.md`) + findings/harness export + OS-keychain secrets**.
   *Implication:* the local-first/single-user posture stays locked; the team-via-git items in "Later" are
   the collaboration story.

### Still open

- **Default permission posture for *trusted* repos.** Even with the trust gate, should a trusted repo
  default to full `bypassPermissions` (max autonomy, current behavior) or to ask/plan with a one-click
  "go autonomous"? (Trades the hands-off appeal against blast radius on the repos you use most.) Lean:
  revisit once the trust gate + PreToolUse enforcement land, since those change the calculus.
