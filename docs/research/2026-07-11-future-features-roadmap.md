# Future-feature roadmap — 5-lane research sweep (2026-07-11)

**Companion to:** `docs/research/2026-07-11-roadmap-v0.3-v0.5.md` (the v0.2→v0.5
train) and Roadmap Map v2 (#141). This doc covers *future* candidate features —
things beyond the currently-mapped T1–T20 tickets — synthesized from five
parallel research lanes:

- **N1 — Fleet orchestration & scheduling** (new frontier)
- **N2 — Run observability, timeline & replay** (new frontier)
- **N3 — Living project memory / knowledge layer** (new frontier)
- **E1 — Scan & findings intelligence** (deepening an existing feature)
- **E2 — Terminal cockpit, round 3** (deepening an existing feature)

Every proposal was cross-referenced against the open ticket set (#141 map,
T1–T20) so overlaps are *folded* into existing tickets rather than duplicated —
see the final section. Five load-bearing claims were spot-checked in code
(file:line inline) so this is grounded substrate, not a summary merge.

---

## §1 Executive summary

The highest-leverage theme is **not** any single lane — it is the observation
that three lanes converge on the same missing primitive and the same moat.
Nightcore's differentiator is *governed autonomy*: autonomy the human can see,
bound, and audit. Every lane found that Nightcore already records the raw
material for the next capability but **never fuses, never closes the loop, and
never lets the fleet govern itself** — the substrate exists, the control plane
doesn't. Concretely:

- **Memory (N3)** is the single highest-leverage *new* idea. The context pack
  already reads `.nightcore/memory/*.md` (`analysis/context.rs:71`) but **no
  producer writes it** (confirmed: zero writers). Adding a human-gated producer
  (Run Reflections) turns "the agent repeats the mistake every run" into "it
  remembered because review rejected it last time" — a story no CLI competitor
  closes. The promotion gate *is* governed autonomy: memory writes are
  proposals, never silent.
- **Observability (N2)** is the *evidence layer* the Trust Report currently only
  summarizes. The join key that fuses the three per-task artifacts (transcript,
  ledger, cost) is missing on exactly one side: transcript events already carry
  `toolUseId` (`packages/contracts/src/events.ts:140,149`), but the ledger record
  is `{ts, tool, inputDigest, decision, ruleId?}` with no id
  (`packages/engine/src/session/session-ledger.ts:63-70`). Stamping that existing
  id into the ledger is a one-field additive change that **unlocks both** the
  fused timeline (N2) *and* per-step cost attribution (already scoped in T8 #149).
- **Fleet (N1)** is where autonomy becomes *governed*: today scheduling is pure
  FIFO by `created_at` (`orchestration/deps.rs:64`, no `priority` field exists)
  and the usage gate throttles on rate-limit heat, not dollars. A spend-budget
  scheduler ("run all night, never spend >$20, P1 first") is the single most
  requested fleet control and the purest form of the moat.

The reinforcement pattern: **the same folded transcript + shared callId feeds
memory distillation (N3), the fused timeline (N2), and per-step cost (T8)** —
build the substrate once, three features light up. And **budgets (N1) are the
backstop that makes runtime spawn (N1) and best-of-N (roadmap D8) safe** — the
governance has to land before the autonomy that needs it.

The lower-leverage findings are the ones that drift *off* moat: a live
multi-run "Fleet Cockpit" is precisely the layer Anthropic is commoditizing
(Agent View — see roadmap §2.2, "must not be a prettier Agent View"), and
terminal spawn-recipes / cockpit-restore are pure convenience. They earn a slot,
but low, and only reframed around governance (per-lane budget/policy state), not
"watch the runs go."

---

## §2 Per-area digest

### N1 — Fleet orchestration & scheduling (new)

**Today:** a real fleet *substrate* — resizable slot pool (`orchestration/slots.rs`,
live `set_max_concurrency`, shrink-never-aborts), fail-closed dependency gating
(`deps.rs`), a 750ms scan-and-dispatch auto-loop (`coordinator/auto_loop.rs`), a
latching breaker (`breaker.rs`), a non-latching pre-launch usage gate on the
*rate-limit* meter (`coordinator/usage_gate.rs`, shipped 2026-07-11), and
worktree-per-task isolation. **Missing = the control plane:** scheduling is pure
FIFO (`deps.rs:64` sorts by `created_at` then `id`; **no `priority` field exists**
— confirmed), there is no dollar budgeting, no fleet-wide run view, and agents
can't grow the fleet at runtime (Decompose is human-mediated, pre-run only).

- **F1 · Fleet Cockpit** — one full-screen live view: every in-flight run as a
  lane with status/current-tool/burn/worktree + per-lane interrupt/park/boost.
  Mostly web (Rust side is aggregation of existing `nc:*` channels — mind the
  CHANNELS tripwire test). *Moat caveat: this is the commoditized Agent-View
  layer; it only earns the moat if the lanes render per-lane **budget and policy
  state**, not just activity.* Risk: N concurrent activity streams hit the
  deferred ActivityLog virtualization debt — must ship windowed.
- **F2 · Policy Scheduler + spend budgets** — replace FIFO with priority +
  reserved lanes per task-kind + dependency-aware boost + a **per-session/per-day
  dollar budget** enforced as a park-at-launch-boundary gate (sibling to
  `usage_gate.rs`, never interrupts in-flight). Directly extends the shipped
  usage-governance work (#135). The most-requested autonomous-fleet control and
  the purest governance surface. Risk: pre-launch-only budgets overshoot on long
  runs (honest "approximate ceiling" UX) + per-provider cost normalization.
- **F3 · Governed Spawn** — a running agent proposes child tasks mid-run (as
  structured output, fixing the known Decompose prose-parse fail-open, seq 777);
  the coordinator materializes them as real board tasks with `parent_task_id` +
  deps, under a spawn policy (fan-out cap, depth cap, auto-under-N/ask-above,
  every spawn ledgered). Autonomy that grows itself, on rails. Risk: runaway
  amplification — needs F2's budget gate as a hard backstop first.

### N2 — Run observability, timeline & replay (new)

**Today:** three disjoint per-task artifacts that are never fused — the
transcript (`store/transcript.rs`, full on disk but `read_transcript` returns a
5,000-event tail), the flight-recorder ledger (`store/ledger.rs`, every gate
decision, digest-not-payload, fail-open), and the Trust Report
(`workflow/trust/`, aggregated on demand, **never persisted**). Cost exists only
at session granularity (`session-completed.costUsd`). **The join key is missing
on the ledger side only** (confirmed above).

- **O1 · Run Flight Deck (fused timeline)** — one ordered, filterable,
  paginated-on-disk timeline per run fusing transcript turns + ledger decisions +
  file writes + gauntlet/review events + worktree commits. The Trust Report
  becomes *clickable* — every guardrail count drills to the exact step. **The
  keystone**: its first slice is stamping the existing `toolUseId` into the
  ledger record (one additive field, also unblocks T8 #149's per-step cost).
  Governance-grade trace — no competitor in the niche has it.
- **O2 · Checkpoint & Fork (replay)** — auto-checkpoint the worktree after each
  file-mutating batch to a shadow ref namespace (`refs/nightcore/checkpoints/…`,
  never branch history), scrub diff-over-time on the timeline, and "fork from
  here" = new worktree at checkpoint N + session resume/re-prompt. The killer
  debug loop: fix the prompt at the divergence point instead of re-running 40
  turns. Risk: Codex may not support session resume (fail-closed capability
  check, same idiom as `supportsHooks`); checkpoints must never leak into
  merge/PR history.
- **O3 · Step Cost & "Why"** — per-turn token/cost recorded into the trace
  (cost strip over the timeline) + an "explain this step" action reconstructing
  rationale from the surrounding transcript window. **The cost strip folds into
  T8 #149; the net-new part is the labeled-reconstruction "why" panel.** Risk:
  post-hoc rationale is a plausible story, not ground truth — must be visibly
  labeled reconstruction with quoted evidence or it *undermines* trust.

### N3 — Living project memory / knowledge layer (new)

**Today:** every *ingredient* of a project memory, but no loop. The context pack
(`analysis/context.rs`) injects `<project>/.nightcore/context.md` on every run,
assembled from `CLAUDE.md`/`AGENTS.md` + `.nightcore/memory/*.md` + the repo map
— but the pack is a manual snapshot, `.nightcore/memory/` **has no producer**
(confirmed: `memory_files()` at `context.rs:71` is a read-only consumer; zero
writers), and nothing retires stale entries. The Harness propose→apply loop and
the `decision-register-integrity` lint are the exact governance and
staleness-check patterns a memory feature reuses.

- **M1 · Run Reflections** — after every finished run (verified / rejected /
  conflicted), a cheap distiller over the folded transcript + ledger + review
  verdict extracts candidate memory entries (gotcha / convention / rationale /
  recipe) as fingerprinted *proposals*; the user promotes them into
  `.nightcore/memory/*.md` (the consumer socket already exists). Review
  rejections and gate failures — already recorded — are the highest-signal
  source. A ~4th clone of the Insight/Harness run-lifecycle pattern. Risk:
  **memory poisoning** (a prompt-injected phrase persisting into every future
  system prompt) — mandatory human gate + `untrusted_block` render + inject/secret
  scan *before* the proposal lands on disk (proposals may be committed).
- **M2 · Memory Freshness Gauntlet** — every memory entry carries
  machine-checkable anchors (paths, symbols, commit SHA); a deterministic
  zero-token verifier (repo_map-style, pure fs/git, fail-open) re-validates on
  pack assembly and *flags-not-deletes* stale entries, excluded from injection
  until re-confirmed. "Your agent's memory is verified against the tree" is a
  Trust-Report-grade claim; `decision-register-integrity` proves the pattern
  already lives here. Rust-core-only + small contract + web badges. Risk:
  over-eager retirement muting a still-true convention — flag-don't-delete,
  symbol-level anchors, loud UI.
- **M3 · Project Recall** — an in-process lexical index (tantivy-class, Rust
  core, zero cloud) over repo_map facts + memory + Insight findings + decision
  docs + per-run distillates, queried two ways: a UI search palette *and* a
  policy-governed agent-side `recall` tool (under deny/ask/allow tiers, results
  through `untrusted_block`). Turns the pack from everything-every-time into
  retrieval-shaped context. The keystone that makes M1+M2 compound. Risk: **the
  index inhales secrets** — index only git-tracked sources + scrubbed distillates
  (never raw transcripts), secret-scan at index time, keep the index git-ignored.

### E1 — Scan & findings intelligence (existing)

**Today:** a strong single-run backbone — engine-side grounding
(`scans/shared/findings.ts`), stable `file | title` fingerprints, cross-category
dedup, a 3-state finding lifecycle owned by the Rust store with
dismissed-history carried across re-runs by fingerprint (`store/insight.rs`), a
race-safe convert-to-task, and a repo|diff scope. **Missing = the layer above a
single run:** nothing diffs run N vs N-1, nothing spans families, dismissals
don't generalize, and diff scope is a prompt suggestion not a computed contract.

- **S1 · Findings Ledger + Delta Report** — one project-level, fingerprint-keyed
  ledger every scan family reconciles into at the existing `reconcile_scan_history`
  seam, so each run reports "N new / M recurring / K resolved" and a single
  cross-family "Open findings" dashboard spans Insight + Scorecard + Harness +
  PR-review — with **Scorecard grade trend (B → B+)** as the headline. *The
  grade-trend chip folds into T8 #149; the cross-family ledger/dashboard is
  net-new* (there is no open Views ticket — #98 is not open). Risk: per-family
  fingerprint semantics differ (Scorecard readings are per-dimension, PR-review
  findings are branch-scoped) — needs per-family namespacing + prune discipline.
- **S2 · Computed diff scope + resolved-detection** — record the scanned commit
  SHA on every run; "diff scope" becomes "git-diff vs the last completed scan"
  computed in Rust (`git_command` chokepoint), **fail-closed** (empty diff =
  "nothing to scan," never silent full-repo). This directly fixes the confirmed
  fail-open at **`scans/insight/manager.ts:213`** where `scope==='diff'` with
  empty `changedFiles` silently bills a whole-repo scan. Extend scope to
  Scorecard + Harness; at reconcile, previous findings inside the changed set but
  not rediscovered → "likely resolved." Makes cheap frequent re-scans rational —
  the precondition for S1's trend data. Risk: "not rediscovered" ≠ fixed (soft
  "likely resolved" + one-click reopen); unreachable baseline SHA → explicit
  full-repo fallback notice, never silent.
- **S3 · Dismissal memory → suppression rules** — upgrade dismissed-carryover
  from exact `file | title` to fuzzy re-match (same file+category, normalized
  title) so reworded findings stay dismissed, plus a "dismiss all like this"
  action that lifts a dismissal into a visible per-project suppression rule
  (category + tag + path-glob), injected into the category prompt *and* applied
  as a counted post-filter. Best effort-to-annoyance ratio; ships independently.
  Risk: over-suppression — post-filter reports "n suppressed" (expandable),
  rules are first-class visible objects, never applies to `critical`.

### E2 — Terminal cockpit, round 3 (existing)

**Today:** rounds 1–2 shipped the daily-driver list — two-tier persistence
(daemon + read-only restore), grid with dnd/zoom, search, broadcast, AI naming,
Seatbelt confinement, task→terminal injection. **Missing = command-level
structure, spawn recipes, working restore.** `SpawnOpts` is `{cwd, confined,
cols, rows}` (confirmed `session.rs:74`) — no env, no startup command.

- **T-1 · Command blocks (OSC 133 shell integration)** — inject fail-soft shell
  integration at spawn so the cockpit understands *commands*, not bytes:
  per-command exit-code gutter marks, jump-between-commands, copy-last-output, a
  real rerun history (replaces the lenient keystroke reconstruction in
  `terminal-command-capture.ts`), exact command-end notifications. *Overlaps the
  already-planned v0.4 "Terminal round 2+" scope in roadmap §6, which lists OSC
  133 — fold there, don't mint a new ticket.* Risk: shell-rc injection fragility
  × the `confine.rs` ZDOTDIR redirect interplay; must be fail-soft.
- **T-2 · Spawn recipes** — named profiles (cwd + env + optional startup command
  + confinement + title) from the NewTabPicker. Pure convenience, off-moat. Risk:
  the profile env merge must run **before** the provider-var scrub in
  `session.rs` (a profile must never reintroduce scrubbed agent credentials);
  startup commands typed-not-executed via bracketed-paste.
- **T-3 · Cockpit restore** — a "Restore cockpit" gesture respawning dead tabs
  as *working* shells (not read-only ghosts), deduped against daemon-attached
  live sessions. Pure convenience, off-moat. Risk: must stay an explicit user
  gesture (startup process execution); attach-vs-respawn dedupe.

---

## §3 Unified ranked table

Ranked by (Value × Moat-fit) ÷ Effort. Value/Moat on 1–5; Effort S=1 / M=2 / L=3.
Bold = recommended near-term (v0.4 or v0.3-stretch).

| # | Idea | Area | New/Exist | Effort | Value | Moat | Risk | Overlaps existing ticket? | Slot |
|---|---|---|---|:-:|:-:|:-:|---|---|---|
| **M1** | **Run Reflections** (memory producer) | N3 | New | M | 5 | 5 | Memory poisoning (human gate mitigates) | — (socket exists in `context.rs`) | **v0.4** |
| **F2** | **Policy Scheduler + spend budgets** | N1 | New | M | 5 | 5 | Pre-launch budget overshoot | **Extends #135** (usage-governance) | **v0.4** |
| **O1** | **Run Flight Deck** (fused timeline + callId) | N2 | New | M | 5 | 5 | Event volume → paginate on disk | callId slice feeds **#149** | **v0.4** |
| **M2** | **Memory Freshness Gauntlet** | N3 | New | S–M | 4 | 5 | Over-eager retirement | — | **v0.4** |
| **S1** | **Findings Ledger + Delta Report** | E1 | Exist | M | 5 | 4 | Per-family fingerprint semantics | grade-trend chip → **#149** | **v0.4** |
| **S2** | **Computed diff scope + resolved-detect** | E1 | Exist | M | 4 | 4 | "not found" ≠ fixed | fixes fail-open `manager.ts:213` | **v0.3-stretch** |
| **S3** | **Dismissal memory → suppression rules** | E1 | Exist | S–M | 4 | 3 | Over-suppression | — (Policy tab neighbor) | **v0.3-stretch** |
| F3 | Governed Spawn (runtime child tasks) | N1 | New | L | 4 | 5 | Runaway amplification | **folds into Decompose + T17 #158** | v0.5 |
| O3 | Step Cost & "Why" | N2 | New | S–M | 3 | 3 | Reconstruction ≠ truth | cost strip → **#149**; "why" net-new | v0.3 fold / v0.4 |
| M3 | Project Recall (lexical index + tool) | N3 | New | L | 4 | 4 | Index inhales secrets | — | v0.5 |
| O2 | Checkpoint & Fork (replay) | N2 | New | L | 5 | 3 | Codex resume; ref leakage | depends on O1 | v0.5 |
| F1 | Fleet Cockpit (live run view) | N1 | New | M | 4 | 2 | "prettier Agent View" (§2.2) | — | v0.4 (reframed) |
| T-1 | Command blocks (OSC 133) | E2 | Exist | M | 4 | 2 | rc-injection × confine | **folds into v0.4 Terminal round 2+** | v0.4 fold |
| T-2 | Spawn recipes (profiles + env) | E2 | Exist | S–M | 3 | 1 | scrub-order; env leak | — | v0.5 / backlog |
| T-3 | Cockpit restore | E2 | Exist | M | 3 | 1 | startup exec gesture | — | v0.5 / backlog |

---

## §4 Recommended sequencing

**Build the shared substrate first, then let three features light up.**

1. **The callId slice (inside O1) is the cheapest highest-leverage move.**
   Stamping the transcript's existing `toolUseId` into the ledger record is one
   additive field (`session-ledger.ts` writer + `store/ledger.rs` reader) — and
   it is the join key that unblocks *both* the fused Flight Deck (O1) *and*
   per-step cost attribution already scoped in **T8 #149**. Do this even if the
   full timeline slips. It also retro-degrades gracefully (pre-upgrade
   transcripts simply lack the id).

2. **Memory M1 → M2 is the highest-leverage new *pair* and rides existing
   sockets.** M1's producer writes into the `.nightcore/memory/*.md` socket that
   `context.rs` already consumes, and it distills from the same *folded
   transcript* that O1's timeline needs — so M1 and O1 share the fold work.
   M2 keeps M1's output honest (verified-against-the-tree) with a deterministic,
   near-zero-risk verifier. **M1 + M2 alone ship a demoable "the agent remembers,
   and the memory is verified" story** — the governed-autonomy narrative no CLI
   competitor closes. This is the single best v0.4 headline.

3. **Scans S2 → S1, in that order.** S2 first because it fixes a *confirmed
   fail-open billing bug* (`manager.ts:213`) and makes cheap frequent re-scans
   rational; only once re-scans are cheap is the trend data dense enough for S1's
   cross-family delta ledger to be worth building. S3 (dismissal suppression) has
   the best ROI and no dependencies — it can ship *first*, independently, as an
   early v0.3-stretch win next to the Policy tab.

4. **Fleet F2 before F3 — the governance is the prerequisite for the autonomy.**
   F2's dollar-budget gate (extending shipped #135) is the hard backstop that
   makes F3's runtime spawn safe; without it, one confused parent fills the queue
   at real cost. F1 (Cockpit) is *not* on the critical path and carries the
   "prettier Agent View" moat risk — slot it only after F2 gives the lanes real
   governance state (per-lane budget/policy) to render.

5. **Defer the frontier-but-heavy trio to v0.5:** F3 (spawn — needs F2 + the
   skill-registry TaskKind opening in #158), O2 (Checkpoint & Fork — needs O1 +
   a Codex-resume capability check), and M3 (Recall — new crate + a governed
   agent-tool surface + secret-scan-at-index). Each depends on a v0.4 substrate
   landing first.

**Net cross-area synergy:** the *folded transcript + shared callId* is the
substrate under M1 (distillation), O1 (timeline), and T8 #149 (per-step cost) —
one investment, three payoffs. Budgets (F2) are the backstop under F3 and
best-of-N. That is why the top of the ranked table clusters at v0.4: the
substrate items unblock the most downstream value per unit effort.

---

## §5 Folded into existing tickets (do NOT mint new tickets for these)

| Idea (lane) | Folds into | What specifically |
|---|---|---|
| O3 cost strip (N2) + S1 Scorecard grade-trend (E1) + e1 cost trends | **T8 #149** (Evidence bundle + cost surfacing) | Per-turn/per-step cost rendering, scorecard per-dimension grade-trend chips — #149 already lists these; the callId join key (O1) is the enabler and should be built as #149's first slice |
| O1 shared `callId` slice | **T8 #149** enabler + O1 | The one additive field both need; land it once |
| F3 Governed Spawn — the "structured propose-subtasks tool" half (N1) | **T17 #158** (Skill registry) + Decompose | Once #158 opens the `Task.kind` wire and structured-output migration lands, the propose-child-tasks tool is a natural skill; the coordinator-materializes-children + spawn-policy half stays a v0.5 candidate |
| F2 dollar-budget gate (N1) | **#135** (usage-governance, shipped) | The spend gate is a sibling of `usage_gate.rs`; F2 extends the shipped arc rather than starting fresh |
| T-1 OSC 133 command blocks (E2) | **v0.4 "Terminal round 2+"** (roadmap §6) | §6 already lists OSC 133 shell integration; add exit-code gutter + rerun history + command nav to that scope |
| S3 suppression-rules UI (E1) | neighbors **Policy tab** (Harden stage) | Ships as a visible rules list beside the existing policy surface — not a new view |

**Net-new candidate tickets** (no existing overlap): M1, M2, M3 (memory arc),
O1 (timeline) + O2 (replay), S1 cross-family ledger, S2 computed diff scope, F1
Cockpit, F2 Policy Scheduler. Terminal T-2/T-3 are backlog-tier (off-moat).

---

## §6 Grounding spot-checks (verified in code this sweep)

| Claim | Location | Verified |
|---|---|---|
| Diff-scope fail-open bills whole repo | `packages/engine/src/scans/insight/manager.ts:213` | ✓ `scope==='diff'` + empty `changedFiles` → "Analyze the whole repository." |
| Ledger record has no join key | `packages/engine/src/session/session-ledger.ts:63-70` | ✓ `{ts, tool, inputDigest, decision, ruleId?}` — no id |
| Transcript events already carry the id | `packages/contracts/src/events.ts:140,149` | ✓ `toolUseId` on `tool-use-requested` + `tool-result` (stamp it into the ledger) |
| Scheduler is pure FIFO, no priority | `apps/desktop/src-tauri/src/orchestration/deps.rs:64` | ✓ sort by `created_at` then `id`; no `priority` field on Task |
| Memory socket has a consumer, no producer | `apps/desktop/src-tauri/src/analysis/context.rs:71-112` | ✓ `memory_files()` reads `.nightcore/memory/*.md`; zero writers |
| SpawnOpts lacks env/command | `apps/desktop/src-tauri/src/terminal/session.rs:74` | ✓ `{cwd, confined, cols, rows}` |
