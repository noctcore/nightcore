---
title: Isolation and sandboxing
description: Worktrees, workspace confinement, and the opt-in macOS Seatbelt sandbox — what each layer contains, and exactly where each one leaks.
sidebar:
  order: 3
---

Containment in Nightcore is three layers, and they are not redundant — each one
closes a gap the one above it leaves open. This page is as much about the gaps
as the layers.

## Layer 1 — the git worktree

Every Build and TDD task gets its **own git worktree and branch**. Read-only
kinds (Research, Decompose, and the internal reviewer) get none, because they
have nothing to write.

What this buys:

- Parallel agents do not fight over one working tree.
- Your `main` checkout is never the thing being edited.
- Discarding a run is deleting a worktree. Reversibility is the default, not a
  recovery procedure.
- Merging is an explicit, gated operation — see [How a change earns its
  merge](../gates/).

What it does not buy: the worktree is a real directory on your real filesystem.
A process that ignores the worktree boundary can still reach outside it. That is
what layers 2 and 3 are for.

## Layer 2 — workspace confinement (the `PreToolUse` gate)

A hook confines agent **writes** to the task's worktree by inspecting each tool
call before it runs. This is the same mechanism the [policy layer](../policy/)
uses, and it shares the policy layer's fundamental property and its fundamental
limit:

- **Property:** it runs regardless of permission mode, including
  `bypassPermissions`.
- **Limit:** it is **lexical**. It reads tool inputs. A write that never appears
  in a tool input — a shell redirect (`echo x > /outside/file`), a symlink, a
  subprocess the agent spawns — is invisible to it.

That limit is documented, not hidden, and it is the entire reason layer 3
exists.

## Layer 3 — the macOS Seatbelt sandbox (opt-in)

On macOS, Nightcore can wrap the whole agent process in Apple Seatbelt
(`/usr/bin/sandbox-exec`) with a deny-write-except profile. Because the wrap is
at the OS level, containment holds **beneath** the agent, its hooks, and
anything it spawns — closing the redirect/symlink/subprocess gaps that layer 2
cannot see.

:::caution[Read the scope carefully]
This is **write containment only**. The profile allows reads and network
traffic; it denies writes outside an explicit set of roots. The goal is to stop
an agent mutating files outside its workspace — **not** to air-gap it. Read and
network containment would break the provider CLI's own credential and config
resolution, and is a different, much larger problem.
:::

### What stays writable

- The session's working directory (the task worktree or project root).
- The git **common dir** when the cwd is a linked worktree — git writes index,
  locks, objects and refs there even for worktree-local commits, and without it
  every `git` command in a worktree session fails. The main checkout's *working
  tree* stays read-only, which is the point.
- `/dev` (tty and null writes from shell commands — devices, not storage).
- The macOS temp trees.
- The provider CLI's own state and cache directories, so a wrapped session can
  still run.

### The config-poisoning carve-out

Inside the otherwise-writable CLI state directory, three things are **denied
anyway**: the CLI's global `settings.json`, its `settings.local.json`, and the
`~/.claude.json*` family.

The reasoning is specific. An autonomous agent never needs to author the CLI's
*global* settings, and such a write is a hook-injection RCE: a planted `hooks`
entry (or an `mcpServers` entry) runs arbitrary shell on the **next** session,
outside this run's containment entirely. Ephemeral session state under the same
directory stays writable, so nothing breaks.

### Known consequences, stated plainly

- **This feature is opt-in and experimental.** It is off by default.
- **Your own CLI hooks may break under it.** A user hook configured in the
  global settings that writes outside the allowed roots will fail. That is the
  containment working as designed — an unexpected writer is exactly what it
  blocks — but it will look like a bug the first time.
- **macOS only.** There is no equivalent module on Windows or Linux. On those
  platforms, layers 1 and 2 are what you have.
- **One residual gap is documented rather than fixed:** the wrapper and profile
  are written into the temp tree, which is itself writable from inside the
  sandbox, so a contained agent could in principle tamper with *another
  concurrently-starting* session's not-yet-executed wrapper. A running session's
  containment cannot be altered — the profile is read once, at exec.

## Layer 0 — the thing none of these fix

The project you opened is readable. Agents can read, modify, and delete files
under the paths you give them, and prompt injection through repo content, issue
bodies, and PR comments is a real channel that fencing mitigates rather than
eliminates.

**Run Nightcore on projects you trust.** For untrusted codebases, use a
dedicated user account or a VM. No gate set is perfect on a bare-metal desktop
install, and this documentation is not going to pretend otherwise.

→ [Limits and honest gaps](../../reference/limits/)
