---
title: Your first task
description: From an empty board to a merged change — what happens at each step, and where the automation stops and you start.
sidebar:
  order: 3
---

This page walks one Build task end to end. The point is less "click here" than
**where the automation stops** — every place Nightcore refuses to proceed
without you is deliberate, and knowing them is how you decide how much rope to
give it.

## 1. Open a project

Nightcore works against a git repository on your machine. Open one, and it
creates a per-project `.nightcore/` directory for state (see
[Files on disk](../../reference/files-on-disk/)).

Nothing is armed yet: with no `.nightcore/harness.json`, there are no
project-specific checks and no policy layer. An existing repo is unaffected by
being opened.

## 2. Add a task to the board

The Kanban Board (`K`) is the control surface. A task carries a title, a
description, and a **kind**:

- **Build** — writes code. Gets a worktree, runs the full verification gauntlet.
- **TDD** — same orchestration as Build, with red → green → refactor enforcement.
- **Research** — read-only, no worktree; the report lands in the transcript.
- **Decompose** — read-only planning that proposes sub-tasks you convert into
  cards.

(There is a fifth kind, **Review**, but it is not in the picker — it is the
identity the verification reviewer runs under.)

Start with **Build** and something small. A first task that touches one file
teaches you more about the gates than one that touches forty, because the
oversized-diff guardrail will park the second one for triage.

→ [Task kinds and the board](../../reference/task-kinds/)

## 3. Run it

Run the task directly, or enable **Auto Mode** and let the loop assign agents.
The auto-loop respects dependency ordering between tasks, caps concurrency, and
pauses itself on repeated failure: a **circuit breaker** trips after 3 failures
inside a 60-second sliding window, so a broken setup (expired auth, wedged repo)
cannot burn through your whole board. A success clears the window; you resume
the loop explicitly once you have fixed the cause.

A Build task moves `Ready → InProgress`, gets its own git worktree and branch,
and starts working. You can watch the live transcript, tool calls, and running
cost.

## 4. Verification happens without you

When the agent says it is done, the task does **not** go to Done. It goes to
`Verifying`, and a fixed battery runs — deterministic gates first, the expensive
reviewer agent last:

1. The work is committed in the worktree (so there is a real diff to judge).
2. **Diff budget** — an oversized diff parks the task for you. A scoping problem
   is not something an agent should auto-fix.
3. **Structure-Lock** — the checks *your project* declared in
   `.nightcore/harness.json`. Absent file, no checks.
4. **Anti-gaming sweep**, **contract budget**, **strictness ratchet** — skipped
   tests, gutted assertions, suppression sprinkling, instruction-file churn, and
   any regression in your `any` / `@ts-ignore` / `eslint-disable` counts.
5. Your task's own verify command, if it has one.
6. **The reviewer agent** — an independent session that reads the diff and
   returns `PASS`, `CHANGES_REQUESTED`, or `FAIL`.

`PASS` marks the task verified. `CHANGES_REQUESTED` triggers a bounded auto-fix
— **at most 2 attempts** — and then parks. `FAIL`, or a verdict that cannot be
parsed at all, parks the task in `WaitingApproval`. There is no path where an
unparseable verdict is treated as success.

→ [How a change earns its merge](../../governance/gates/)

## 5. Read the receipt, then decide

A verified task carries a **Trust Report**: which gates ran, what they returned,
diff stats, and cost. Underneath it, `.nightcore/ledger/<taskId>.ndjson` holds
every tool decision the session made — allowed, asked, or denied — with the rule
id responsible.

This is the step the product is built around. You are not being asked to trust a
summary the model wrote about itself; you are reading a file the gates wrote.

→ [Receipts](../../governance/receipts/)

## 6. Ship it

From the task drawer you can commit, merge, or open a pull request — all from
the worktree, without checking out `main`. Merging runs a **separate pre-merge
readiness gauntlet**: it detects your project's own `typecheck` / `lint` / `test`
scripts (or `cargo check` / `clippy` / `test`), runs them in order, and stops at
the first failure. It never invents a command that is not in your manifest.

If you would rather not merge locally, the [PR review
pipeline](../../reference/pr-review/) can review the pull request itself with a
diff-grounded scan — and it will not post a single comment to GitHub until you
confirm.

## Where to tighten next

A first task runs with almost nothing armed. The natural next step is to give
the harness something to enforce:

- Run a scan from [Understand](../../lifecycle/understand/) to see what the repo
  actually looks like.
- Let [Harden](../../lifecycle/harden/) propose conventions and lint rules, and
  apply the ones you agree with.
- Arm them in [Enforce](../../lifecycle/enforce/) so the next task is checked
  against them.
- Consider a [policy](../../governance/policy/) — protected paths, denied
  commands, ask-first tools.
