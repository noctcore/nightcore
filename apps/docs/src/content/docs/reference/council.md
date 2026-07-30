---
title: Council
description: A governed multi-agent debate board — what is shipped, what is reachable, and the specific things that are implemented but not wired or not yet verified.
sidebar:
  order: 4
---

Council (`C`) is a debate board: several agent seats argue a problem through
structured stages, a deterministic gate can override their consensus, and a
human holds the gavel.

The honest framing matters here, because "more agents" is not a thesis:
**Council is governed reasoning, not the claim that more agents are smarter.**
Its value is that the disagreement is structured, the transcript is append-only,
and the conclusion has to survive both an objective check and a human.

:::caution[Read the "not done" section]
Council is the least settled surface in the product. Several capabilities exist
in code but are not reachable from any shipped preset, and its most significant
capability — actually writing code — has **not been verified end to end against
a live provider**. That is stated below rather than buried.
:::

## The vocabulary

- **Stages**: `frame`, `propose`, `debate`, `converge`, `build`, `review`
- **Seat roles**: `proposer`, `critic`, `judge`, `conductor`, `human`
- **Routing**: `moderated-bus` only — a Conductor is the sole writer to the
  transcript. Peer-to-peer routing is deliberately not declared.

## The three presets

All three run the same three seats — two proposers and a critic.

| Preset | Stages | Objective gate | Convergence |
|---|---|---|---|
| `research` | frame → propose (blind) → debate → converge | none | human |
| `ui-bug` | + `build` before converge | `repro` | human |
| `coding` | + `build` before converge | `build` | human |

"Propose (blind)" means proposers do not see each other's proposal before making
their own — the point of two proposers is independent starting positions, not an
echo.

## The objective gate

An **objective gate** is a deterministic check whose **RED verdict overrides
debate consensus**. Three agents agreeing does not beat a failing build.

Two kinds:

- **`repro`** — a failing check that must go red → green.
- **`build`** — a typecheck / lint / test gauntlet over the writer's worktree.

The gate reuses the existing Structure-Lock gauntlet rather than introducing a
new execution path, so it inherits the same confinement as everything else. The
seam is deliberately narrow: a context goes in, a `{ passed, summary, checks }`
verdict comes out, and `passed` is the only field that decides the override.

## The terminal judge

Convergence in every shipped preset is **human**. You resolve a council with one
of three decisions:

| Decision | Requires |
|---|---|
| `accept` | which seat's answer you are accepting |
| `reject` | — |
| `judge` | a note explaining your own ruling |

The verdict flows through the Conductor onto the append-only transcript. It is
never written directly to the store, so the record of "who decided what" has the
same integrity as the debate itself.

## Yes, it writes code

Council has a real write-capable driver. When a preset includes the `build`
stage:

- A worktree is allocated through a **path-less RPC**: the engine sends a run
  id, the host derives every path. The engine never supplies a filesystem
  location, so it cannot ask for one outside the sanctioned tree.
- A **single elected writer** runs — elected from the debating seats, **never a
  judge seat** — write-capable and Seatbelt-wrapped.
- The work is committed. **It never merges.** Merge and discard stay human-only.

## What is NOT done

This section is the reason to read this page.

- **The `review` stage is dormant in production.** The stage exists and the
  conductor implements it, but no review driver is injected by the shipped
  router. A preset that named it would get nothing.
- **`judge-agent` and `vote` convergence are unreachable.** The schema accepts
  them and the conductor implements them, but all three registered presets are
  `convergence: 'human'`. There is no way to select the others from the UI.
- **There is no human→seat steering.** The canvas *reads* the debate stream;
  there is no command that feeds text back into a seat's prompt. Mediated
  broadcast / DM / steer is tracked as
  [#361](https://github.com/noctcore/nightcore/issues/361) and is a substantial
  feature, not a tweak.
- **Hardening follow-ups are deferred**, including a fail-**closed** Seatbelt
  posture for the writer and dependency provisioning in the writer's worktree —
  tracked as [#387](https://github.com/noctcore/nightcore/issues/387).
- **The live end-to-end write is unverified.** CI exercises the driver with the
  writer execution faked, which proves the wiring and not the outcome. Treat the
  build stage as experimental until someone has dogfooded it against a real
  provider.

The tracking issue for the whole surface is
[#334](https://github.com/noctcore/nightcore/issues/334).

## Should you use it?

For **research** — arguing a design decision, stress-testing an approach before
you build it — it does what it says, and the transcript is genuinely useful
afterwards.

For **`build`-stage work**, prefer the board. A Build task gets the full
[verification gauntlet](../../governance/gates/), a
[Trust Report](../../governance/receipts/), and a merge path that has been
exercised. Council's writer has a narrower, newer, less-verified path around it.
