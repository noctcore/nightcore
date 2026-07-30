---
title: What is Nightcore?
description: A local-first desktop studio that runs coding agents through the whole development loop, with the boundaries enforced by the product instead of requested in a prompt.
sidebar:
  order: 1
---

Nightcore is a **local-first desktop studio** that runs coding agents as an
autonomous development team. You describe work as cards on a Kanban board;
agents plan, build, and test in parallel, each in its own isolated git worktree.

There is no server, no database, and no account. State lives under
`~/.nightcore/` and a per-project `.nightcore/` directory. It drives the agent
CLI you have already installed and authenticated — it does not bundle
credentials and does not run a cloud backend.

## The thesis: governed autonomy

An agent that writes code is easy. An agent whose output you can *merge without
reading every line* is not.

Left unsupervised, agent failure modes are predictable and boring:

- **Architecture erosion.** A diff can compile, pass tests, and still import
  across a layer boundary, duplicate an existing module, or ignore every
  convention your team spent a year establishing. "Green" is not "right."
- **Gaming the gate.** Agents optimise for *done*: skip the failing test,
  sprinkle `@ts-ignore`, gut an assertion, quietly widen the scope until the
  diff touches forty files.
- **Untrusted input.** Task descriptions, issue bodies, PR comments, and repo
  files are all channels for prompt injection — text that turns your own agent
  against your own machine.
- **Review that doesn't scale.** A diff viewer and a "waiting approval" column
  work for one agent. At three agents in parallel, eyeball review degrades into
  a rubber stamp.

Most tools answer these with advice: *review carefully, use a worktree.*
Nightcore's answer is to keep the autonomy at full speed and make the boundaries
**enforced instead of advisory**.

That cashes out as three properties, and most of this documentation is an
elaboration of one of them.

### Bounded

Build and TDD tasks get their own git worktree, so an agent's work is not on
your branch until you say so. Tool calls pass through a `PreToolUse` policy
layer that runs **regardless of permission mode — including
`bypassPermissions`**. On macOS an opt-in Seatbelt sandbox wraps the whole agent
process, so write containment holds beneath the agent, its hooks, and anything
it spawns.

→ [Isolation and sandboxing](../../governance/isolation/) ·
[Policy](../../governance/policy/)

### Inspectable

Every tool decision — allowed, asked, or denied — is appended to a flight
recorder on disk at `.nightcore/ledger/<taskId>.ndjson`. Governance changes
(policy saves, arming a check, snapshotting a ratchet) land in a separate
append-only project journal. A per-task Trust Report and a per-project trust
summary read from those files rather than from a model's account of itself.

→ [Receipts: the ledger, the journal, and the badge](../../governance/receipts/)

### Reversible

Work lands as commits on a task branch in a worktree. Nothing reaches your
branch until a verdict says it may, and discarding a run is deleting a worktree.
The merge path is downstream of the gates, not parallel to them.

→ [How a change earns its merge](../../governance/gates/)

## What it is not

Being clear about this saves you an evaluation:

- **It is not a chat window with a diff view.** The unit of work is a task on a
  board with a state machine behind it, not a conversation.
- **It is not a hosted product.** There is nothing to sign up for, and no code
  leaves your machine except through the provider CLI you already use.
- **It is not a security boundary you should bet a hostile codebase on.** It
  runs AI agents with access to your filesystem and shell. The harness reduces
  risk substantially; it does not make an untrusted repo safe to open. Read
  [Limits and honest gaps](../../reference/limits/).
- **It is not Claude Code, and it is not affiliated with Anthropic.** Claude is
  the default provider; Codex is available as a second one behind the same seam,
  with a smaller feature surface — see [Providers](../../reference/providers/).

## How the pieces fit

The workspace is organised as a lifecycle — [Intake → Understand → Harden →
Enforce → Verify](../../lifecycle/) — and the loop closes on itself:

**Scans propose the guardrails, Apply writes them, the Structure-Lock enforces
them, the gauntlet verifies against them.**

That is the part that is hard to copy. Any tool can run an agent. The value here
is that the *rules your agent is checked against are your project's own rules*,
extracted from your repo, applied with your review, and then mechanically
enforced on every run.
