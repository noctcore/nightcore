---
title: Task kinds and the board
description: The five task kinds, what orchestration each one gets, the seven task states, and how Auto Mode and the circuit breaker behave.
sidebar:
  order: 1
---

## The five kinds

| Kind | Worktree | Verified after | Writes code | Notes |
|---|---|---|---|---|
| **Build** | yes | yes | yes | The default. Full verification gauntlet. |
| **TDD** | yes | yes | yes | Same orchestration as Build, with red → green → refactor enforcement. |
| **Research** | no | no | no | Read-only; may use web tools. Report lands in the transcript. |
| **Decompose** | no | no | no | Read-only planning that proposes sub-tasks you convert into cards. |
| **Review** | no | no | no | **Not in the picker.** The identity the verification reviewer runs under. |

The split is not cosmetic — it is a policy table. A kind that does not allocate a
worktree has nothing to verify, so it terminates when its session does.
Sub-tasks proposed by Decompose are `Open` until you convert them, at which point
they become real board tasks.

## The seven states

`Backlog` → `Ready` → `InProgress` → `Verifying` → { `WaitingApproval` | `Done`
| `Failed` }

- **`Verifying` holds the slot and the worktree** across build → verify → fix.
  Only a terminal state releases the run, which is why a task stuck verifying is
  still consuming concurrency.
- **Crash recovery is requeue, not resume.** Tasks left `InProgress` or
  `Verifying` when the app died are moved back to `Ready` at boot. Half-finished
  agent state is not something to resume from.

## Auto Mode

Auto Mode runs the loop for you. It:

- assigns agents to `Ready` tasks,
- respects **dependency ordering** between tasks,
- caps **concurrency** at your configured limit,
- and trips a **circuit breaker** on repeated failure.

### The circuit breaker

The breaker counts failures in a **sliding 60-second window** and pauses the
auto-loop when **3** land inside it. A success clears the window, so an
intermittent failure between successes never trips it.

Once tripped, the pause **latches**. You resume explicitly, after fixing the
cause. That is deliberate: the failure modes it exists for — expired
authentication, a wedged repository, a provider outage — are all cases where
retrying automatically just burns the rest of your board.

## Per-task controls

A task carries more than a title and a body. Depending on provider capabilities,
you can set its kind, run mode, permission mode, model, effort, max turns, max
budget, dependencies, and its own verify command.

Where a provider does not support one of these, Nightcore **declares it
unsupported** rather than silently ignoring it — so the UI can caveat instead of
lying. See [Providers](../providers/).

## The board is not the only surface

The Kanban Board (`K`) is the control surface, but a project also has:

- **Worktrees** (`W`) — a standalone manager for per-task branches, with merge
  preview, diff view, and discard.
- **Terminal** (`L`) — built-in per-project terminals with persistent sessions,
  so the shell you drive agents from lives beside the board. Terminal spawns
  deliberately **strip provider environment variables**, so a shell you open is
  not silently carrying an agent's credentials or mode flags.
- **History** (`R`) — every past run and scan, with cost, duration, and outcome.
- **Council** (`C`) — the multi-agent debate board; see
  [Council](../council/).
