# Research: Council — a governed multi-agent debate board

**Date:** 2026-07-13
**Agents:** 2 Opus research agents + 1 Fable synthesis + 1 Fable design mockup
**Status:** research + design complete; NOT built. Greenlit for research/design only.
**Mockup:** https://claude.ai/code/artifact/7619e9ec-4866-4e76-b1bd-07db90dfda2b ("Nightcore — Debate Board")

## Problem

Explore a future Nightcore feature (working name **Council**), inspired by the "ACE"
app's flow-canvas of agents debating live: a React-Flow board where heterogeneous
agents ("seats") debate to solve a task — coding, research, or a UI bug — while a
human reads and steers via a team-chat panel. Each seat has a stream under the hood;
a **broadcast** control sends one prompt to all seats at once.

This doc captures the research + architecture + phased roadmap so the idea survives
past the session it was produced in — it was previously only living in an ephemeral
job-scratch file and this repo's memory, with no tracking issue.

## The honest frame (the whole pitch)

**"Governed reasoning, not more-agents = smarter."** Multi-agent debate is *not* a
general accuracy boost — literature shows symmetric debate can overwrite a correct
answer with confident wrong consensus. The value is narrow but real, in four places:

1. **Heterogeneous models** — Opus × Codex × Sonnet produces genuine disagreement,
   not an echo. Nightcore's provider seam already enables this.
2. **Asymmetric roles** — proposer vs. adversary/critic vs. judge.
3. **Parallel breadth** — for research tasks.
4. **Adversarial verification.**

So the design invariant is: objective gates (tests / repro / build) outrank debate;
dissent is measured and *displayed*, never smoothed over; the human is the terminal
judge. This is Nightcore's governed-autonomy moat applied to reasoning — competitors
ship "spawn N agents"; nobody ships governed multi-agent with per-seat sandboxes, a
mediated bus, objective gates, and a human gavel.

## Architecture

Seats emit onto a **moderated shared bus**, scoped by stage. A **conductor**
(orchestrator, not a peer) owns turn-taking, routing, and convergence — no
agent-to-agent command authority, which is the injection firewall.

State machine (not free chat):

```
Frame → Propose (blind, parallel — preserves diversity)
      → Debate (≤3 rounds, early-stop on stability)
      → Converge (judge-agent | vote | HUMAN)
      → Build (SINGLE writer on an isolated worktree)
      → Review (adversarial + objective gate)
```

- Canvas edges = editable routing policy ("A informs B").
- Team chat = a human-readable projection of the bus.
- Human controls: broadcast-all, DM-one, steer-stage, judge/accept/reject.
- **Broadcast semantics**: a shared `broadcast_id` + per-seat `seq`, appended to
  each seat's own private context; bounded max-concurrency; a collector resolves on
  quorum or timeout (a hung seat can't stall the board); N replies render
  side-by-side — disagreement is the product, not noise to collapse.
- Presets are data (`{roles, models, stages, routing, success_criterion,
  convergence, budget}`), modeled on the existing `TaskKind` → skill-registry
  pattern.

## Nightcore fit — roughly 60-70% of the plumbing already exists

| Need | Reuse |
|---|---|
| N concurrent provider-neutral sessions | `packages/engine/src/session/session-manager.ts` |
| Live-resizable parallelism cap | `orchestration/slots.rs` `SlotManager` |
| Heterogeneous providers behind one seam | `packages/engine/src/providers/agent-provider.ts` + claude/codex + provider-factory |
| Per-agent stream → UI node | `sidecar/{reader,channels}.rs` → `apps/web/.../board/session-stream.ts` → `ActivityLog` (Shiki) — used as a seat node, **not** PTYs |
| HITL approvals / questions / refine-task | `bridge/commands/run-interaction.ts`, `InteractionDock` |
| Multi-round convergence loop | Deep-Scan's `packages/engine/src/scans/shared/` `ScanManager` — fork for Conductor rounds |
| Event channel pattern | `nc:*` channels (add `nc:debate`; the CHANNELS tripwire already enforces registration) |
| Sandboxing / isolation | governance tiers + Seatbelt sandbox per agent; isolated worktrees + merge/discard + `CommitLease` single-flight |
| Budget cap | usage meter (#121) |

**Net-new work:**

1. React-Flow canvas + a new `AppView` (`AppShell.types.ts`) — the only genuinely
   new UI surface. Libraries already on hand: `@dnd-kit`, `motion`, `shiki`,
   `react-virtual`.
2. `nc:debate` bus + shared transcript store — the biggest conceptual gap: today,
   sessions never talk to each other.
3. Conductor stage/turn state machine — forks the Deep-Scan convergence loop.

**Hard wall:** real PTY terminals are user-only, agent-inaccessible by design
(`terminal/mod.rs:6-13`). Seats render the *event stream*, never a PTY.

## ⭐ Highest-leverage unlock (Phase 0)

Ships standalone value in days, with **zero Council code**: wire the ~80%-built
`send-input` path, which today goes nowhere.

- Contract: `send-input {sessionId, text}` — `packages/contracts/src/commands.ts:170`
- Consumer: `session-manager.ts:146`
- Both providers already implement `streamInput`:
  `providers/claude/session-runner.ts:431` (`enqueueInput`),
  `providers/codex/codex-agent-provider.ts:273`

**The gap:** no Rust `send_input` Tauri command, and no web bridge command.

Wiring it needs: a Rust command (must be async + `spawn_blocking` + `try_state`,
per the existing Tauri-command-threading contract — a sync command blocks the
WKWebView); a `bridge/commands/sendInput` wrapper; a chat composer near
`InteractionDock`; and broadcast support by porting
`terminal-broadcast.ts`'s `resolveBroadcastTargets` / `writeToTargets` onto
`sendInput` across live session IDs.

This single unlock delivers **chat-with-a-running-agent** and
**broadcast-to-agents** at once — independently useful even if Council itself
never ships.

## Phases

- **P0 — Unlock** (S, low risk): wire `send-input` end-to-end (above).
- **P1 — MVP Council** (L, medium risk): one Research preset, ≤4 seats with ≥2
  *distinct* models enforced, `Frame → Propose(blind) → Debate(≤2) →
  Converge(human judge only)`, `nc:debate` bus + transcript store, a Conductor
  forked from `ScanManager`, broadcast collector, side-by-side reply diff, budget
  cap + early-stop, replay, canvas (React-Flow; grid fallback via
  `TerminalGrid` if React-Flow fights the layout), preset-as-data (zod + ts-rs
  codegen both ways), full safety baseline (below). Out of v1 scope: autonomous
  Build, agent-judge/vote, editable edges, other presets, a scorecard.
- **P2 — Objective Council** (L, medium-high risk): UI-bug preset
  (reproduce-first; gate = repro red→green), Coding preset (debate the *plan*
  only), single-writer Build on an isolated worktree (reuse the confinement gate
  + `CommitLease` + Seatbelt), objective gate as terminal judge (a failing gate
  overrides consensus — add an explicit test for this), adversarial Review (reuse
  the PR phase-4 reviewer), editable routing edges, judge-agent/vote convergence,
  a no-progress detector.
- **P3 — v2+** (incremental): a "was it worth it" scorecard (cost vs. a
  single-agent baseline), adaptive convergence + a "skip council" hint, cheap
  critic seats, a custom preset editor, board integration ("Convene council" on
  any task/finding; Council as a `TaskKind`).

## Safety non-negotiables (all required from v1)

1. Conductor-mediated bus; zero agent-to-agent command authority.
2. Inter-agent messages are **untrusted data** — injection-scanned and delivered
   *quoted*, never as an instruction (`Seat B said: "…"`).
3. Per-seat OS sandbox + governance tier.
4. Hard budget/round caps + a kill switch. Never "run until they agree."
5. Single-writer builds on isolated worktrees.
6. Objective gates outrank debate.
7. Human is the terminal authority; an append-only transcript + replay makes the
   run auditable.

## When *not* to use it

- Knowable-right-answer tasks — debate can overwrite a correct answer.
- Small tasks — the cost is multiplicative (5-10×) for zero delta.
- Homogeneous seats — sycophantic agreement, not real disagreement.
- When an objective check already decides the outcome.
- When you need speed.
- Execution, not reasoning — debate plans, it never types keystrokes.

## Related

- `docs/research/2026-07-12-deep-scan-mode.md` — the convergence loop Council's
  Conductor forks.
- Worktree isolation + merge/discard (`apps/desktop/src-tauri/src/worktree/`) —
  the single-writer Build isolation P2 reuses.
- `TaskKind` → skill-registry pattern — the model for preset-as-data.
