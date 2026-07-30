---
title: Limits and honest gaps
description: What is alpha, what is macOS-only, what needs a real provider account, and what is implemented but unverified — collected in one place rather than scattered through the docs.
sidebar:
  order: 8
---

Every page in this documentation ends with a "where the honesty is" section.
This page collects them, plus the things that did not belong anywhere else.

If you are evaluating Nightcore, read this page **first**. It is the one most
likely to save you time.

## Status: alpha

[v0.1.0](https://github.com/noctcore/nightcore/releases/latest) shipped with
macOS/Windows installers and signed auto-update. It is functional and dogfooded
daily — Nightcore's own backlog is built by Nightcore — and it is **not
production-ready**. APIs, UI, and on-disk formats can break between releases.

## Security: the disclaimer is not boilerplate

**This software runs AI agents with access to your filesystem and shell. Use at
your own risk.**

The harness reduces risk — policy tiers, workspace confinement, injection
quarantine, the opt-in OS sandbox — but **no gate set is perfect on a bare-metal
desktop install**. Agents can read, modify, and delete files under the project
paths you open.

Run only on projects you trust. For untrusted codebases, use a dedicated user
account or a VM.

Specific known limits:

- **The policy layer is lexical.** It inspects tool inputs, so shell redirects,
  symlinks, and subprocess writes are invisible to it. Closing that requires the
  OS sandbox.
- **The OS sandbox is macOS-only, opt-in, and write-only.** It denies writes
  outside a set of roots; reads and network are allowed. There is no equivalent
  on Windows or Linux.
- **The sandbox has one documented residual gap**: the wrapper and profile live
  in the writable temp tree, so a contained agent could tamper with *another
  concurrently starting* session's wrapper. A running session's containment
  cannot be altered.
- **Prompt injection is mitigated, not solved.** External text (issue bodies, PR
  comments) is fenced as untrusted and an injection scan flags suspicious repo
  content, but fencing is a mitigation.

→ [Isolation and sandboxing](../../governance/isolation/)

## Platform

| | macOS | Windows | Linux |
|---|---|---|---|
| Installer published | yes (Apple Silicon + Intel) | yes | **no** |
| Signed auto-update | yes | yes | n/a |
| OS-level Seatbelt sandbox | yes (opt-in) | **no** | **no** |

Linux is best-effort: build from source.

## You need a real provider account

Nightcore does not bundle credentials and does not proxy anything. It drives a
provider CLI you have installed and logged into. Without one, there is nothing
to run.

Model usage is billed to **your** provider account. Deep scans, multi-lens PR
review, and Council all do substantially more model work than a single task —
that is a spend decision, not a setting.

:::note[The all-$0 failure signature]
A scan that "fails" with zero cost and zero input tokens is almost always a
provider rate or usage limit, not a bug in Nightcore.
:::

## Provider parity is not equal

Codex is wired but declares a materially smaller capability set: no hooks, no
Harness policy layer, **no flight-recorder ledger**, no turn or budget caps,
token-only cost telemetry, and only two autonomy levels.

A policy-armed project **refuses to run on Codex** (fail-closed). The missing
ledger is *not* a refusal condition — a Codex run simply produces no audit
trail.

→ [Providers](../providers/)

## Unverified or not wired

Stated plainly, because these are the claims most likely to be over-read:

- **Council's build stage has never been verified end to end against a live
  provider.** CI exercises the write-capable driver with the writer execution
  faked. The wiring is proven; the outcome is not.
- **Council's `review` stage is dormant** — implemented, not injected in
  production.
- **Council's `judge-agent` and `vote` convergence modes are unreachable** — all
  three shipped presets converge on a human.
- **There is no human→seat steering in Council.** The canvas reads the debate
  stream; nothing feeds text back into a seat.

→ [Council](../council/)

## Measurements that are approximate on purpose

- **Spend in the trust summary counts the last run per task only.** Do not
  reconcile it against a provider invoice.
- **The governance badge measures your gauntlet pass rate, not code quality.** A
  project with one trivial armed check can show bright green.
- **The gauntlet pass rate is absent, not zero, when nothing has run.** A 0%
  that means "never measured" would be a lie, so it is not shown as one.
- **The flight recorder is fail-open.** A filesystem error disables the writer
  rather than blocking the agent. An empty ledger is not proof that nothing
  happened.
- **The PR review diff is capped at 512 KiB.** A very large pull request is
  reviewed on a truncated diff.

## Things that are model output, not measurement

Scan findings are grounded — every one points at real code — but grounding is
not proof, and a grounded finding can still be wrong about the consequence.
Scorecard grades are comparative judgements. Issue validation reads the code; it
does not run your tests.

The reviewer agent's `PASS` is a judgement too. What the product guarantees is
that it is *independent*, *diff-grounded*, and **cannot pass by silence** — an
unparseable verdict is treated as a failure.

## Where to report the gaps

- Bugs and feature requests:
  [issues](https://github.com/noctcore/nightcore/issues)
- Security vulnerabilities: **not** a public issue — see
  [SECURITY.md](https://github.com/noctcore/nightcore/blob/main/SECURITY.md)
- Roadmap: the [planning
  map](https://github.com/noctcore/nightcore/issues/141) links every ticket
