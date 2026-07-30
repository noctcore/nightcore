---
title: How a change earns its merge
description: The verification gauntlet in order — the deterministic guardrail battery, the reviewer agent, the bounded auto-fix, and the separate pre-merge readiness gauntlet.
sidebar:
  order: 1
---

When a Build or TDD agent says it is finished, the task does **not** move to
`Done`. It moves to `Verifying`, and a fixed battery runs. This page is that
battery, in the order it actually executes.

The ordering principle is worth stating up front: **the deterministic gates run
first, the paid reviewer runs last.** Everything that can be decided by an exit
code is decided before a single reviewer token is spent.

## The task state machine

A task is in exactly one of seven states:

`Backlog` · `Ready` · `InProgress` · `Verifying` · `WaitingApproval` · `Done` ·
`Failed`

`Verifying` holds the task's concurrency slot and its worktree across
build → verify → fix. Only a true terminal state — `Done`, `WaitingApproval`, or
`Failed` — releases the run. If the app crashes, tasks left in `InProgress` or
`Verifying` are requeued to `Ready` at boot rather than resumed mid-flight.

Read-only kinds (Research, Decompose, and the internal Review kind) get **no
worktree and no verification** — there is no diff to verify.

## Step 0 — commit the work

In worktree mode the agent's work is committed inside the worktree first, so
that `base...HEAD` is a real diff. Every gate below judges that diff, not the
model's description of it.

## Step 1 — diff budget

An oversized diff is measured against the project's configured
`maxChangedLines` / `maxChangedFiles`.

A breach **parks the task for human triage**. It is never auto-fixed, and this
is deliberate: a diff that ran away is a *scoping* failure, and asking the agent
that produced it to fix its own scope is how you get a bigger diff.

## Step 2 — Structure-Lock

The checks your project declared in `.nightcore/harness.json` run — the manifest
is read from the trusted project root, the commands execute in the worktree.

No manifest, no checks. This is the [Enforce](../../lifecycle/enforce/) stage
paying off: a task cannot pass verification while breaking the rules its own
repo declares.

## Step 3 — the guardrail battery

Only if Structure-Lock passed, three independent read-only measurements run
concurrently and are folded in a fixed order, stopping at the first failure:

### Anti-gaming sweep

Always on for worktree builds. It looks for the specific ways an agent makes a
red gate green without doing the work: focused or skipped tests, gutted
assertions, sprinkled suppressions, and tampering with the gate configuration
itself. It also reads the flight-recorder ledger for evidence of a `--no-verify`
bypass. Failures carry the exact evidence.

### Contract budget

Caps how much of the project's instruction surface — `AGENTS.md`, `CLAUDE.md`
and friends — one task may churn. An agent that rewrites its own contract has
edited the referee.

### Strictness ratchet

Snapshots the project's `any` / `@ts-ignore` / `eslint-disable` counts and fails
any task that regresses them. **One-way**: the baseline can go down, never up.
Snapshotting a new baseline is recorded in the governance journal.

## Step 4 — your verify command

If the task carries its own verify command, it runs in the review directory.

## Step 5 — the reviewer agent

An independent session reads the diff and returns one of three verdicts:

| Verdict | What happens |
|---|---|
| `PASS` | Task is `Done` and marked **verified**. Optional auto-commit fires. |
| `CHANGES_REQUESTED` | A bounded auto-fix runs — **at most 2 attempts** — then the task parks. |
| `FAIL` | The task parks in `WaitingApproval`. |

**Fail-safe by construction:** the verdict is parsed from the reviewer's output,
and if no verdict token is found at all, the result is `Fail`. A reviewer that
crashes, rambles, or gets truncated cannot produce a pass.

If the reviewer cannot even be started, the result is inconclusive and the task
parks. Inconclusive is never treated as success.

## The rails-collision case

One special case is worth knowing about, because it looks like a defect and is
not.

If the gates failed *and* the ledger shows the agent was denied on protected
paths by your own Harness policy, the task is **parked** rather than failed. The
agent did not write bad code; it ran into rails you set. That is a
configuration conversation, not a bug report — so it goes to you instead of into
an auto-fix loop.

## The other gauntlet: pre-merge readiness

Do not confuse the verification gauntlet above with the **pre-merge readiness
gauntlet**, which gates `merge` (not `commit`).

It is deterministic and costs no agent time, and it **never invents a command**.
It detects what your project already declares:

- Node: `typecheck` (or `tsc`) → `lint` → `test` from `package.json` scripts
- Rust: `cargo check` → `cargo clippy` → `cargo test`

They run sequentially and **stop at the first non-zero exit** — every later step
is marked *skipped*, not passed. Creating a PR is gated on the same bar: the
task must be in worktree mode, committed, verified, and passing this gauntlet.

## What this does not do

- It does not prove the change is correct. It proves the change satisfies the
  checks that exist.
- It does not make the reviewer agent infallible. It makes the reviewer
  *independent*, *diff-grounded*, and *unable to pass by silence*.
- It does not stop you from merging. You can always override — you just cannot
  do it by accident, and the [receipt](../receipts/) records what you overrode.
