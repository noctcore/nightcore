---
title: Providers and authentication
description: Claude and Codex behind one provider seam — the declared capability matrix, what Codex cannot do, and why Nightcore has zero credential code.
sidebar:
  order: 5
---

Nightcore's orchestration core is **provider-agnostic by construction**: agent
SDKs exist in exactly one process (the Bun sidecar), behind a neutral provider
seam. Adding a provider does not mean rewriting orchestration.

Two providers are wired today: **Claude** (default) and **Codex**. A third,
replay-only provider exists for offline end-to-end testing and is opt-in via an
environment variable.

## Zero credential code

This is worth being precise about, because it is a security property and not a
convenience:

- Nightcore **never passes an API key** to a provider SDK.
- It drives the CLI you installed and lets that CLI resolve its own credentials.
- `ANTHROPIC_API_KEY`, if present in the inherited environment, is honoured as a
  fallback by the CLI — Nightcore does not supply it.
- For Codex, the child process environment is **curated down to `PATH`, `HOME`,
  `SHELL`, and `CODEX_API_KEY`**. Notably it does *not* forward
  `OPENAI_API_KEY`.
- Terminals you open inside Nightcore have provider variables **stripped**, so a
  shell is not silently inheriting an agent's credentials or mode flags.

## The capability matrix

Every provider declares its capabilities explicitly, and the declaration is
complete by design — a provider cannot leave a flag unset and inherit an
optimistic default.

| Capability | Claude | Codex |
|---|---|---|
| Autonomy levels | `bypass`, `auto-accept`, `ask`, `plan` | **`auto-accept`, `plan` only** |
| Hooks | yes | **no** |
| Harness policy layer | yes | **no** |
| Flight-recorder ledger | yes | **no** |
| Provides own write containment | no | yes |
| MCP servers | yes | yes |
| Plan mode / structured output / session resume / setting sources / session store / effort | yes | yes |
| File checkpointing | yes | **no** |
| Ask-user-question | yes | **no** |
| Max turns | yes | **no** |
| Max budget | yes | **no** |
| Cost telemetry | full | **tokens only** |

### Why the Codex gaps are declared rather than faked

Each "no" above has a reason, and the design choice throughout is to **declare
the limitation so the UI can caveat it**, rather than accept the setting and
silently ignore it:

- **No `ask` autonomy level.** The Codex SDK has no approval channel, so an
  `ask` posture could never be answered — the run would hang. Offering it in the
  picker would be a deadlock trap, so it is not offered.
- **No max turns / max budget.** The SDK's turn options expose neither. Declared
  `false` rather than accepted-and-dropped.
- **No Harness policy support.** This one is **fail-closed**: a run against a
  project whose Harness policy is *armed* is **refused**, not run ungoverned.
- **No ledger.** Declared truthfully, but — unlike policy — this is *not*
  currently a refusal condition. A Codex run proceeds **without a flight
  recorder**. If auditability is why you are here, that is a material gap.

Read-only Codex sessions (the reviewer, decompose) are pinned to `plan`
autonomy regardless of what was requested.

## Choosing a provider

Set the provider in Settings.

- Choose **Claude** if you want the governance surfaces: policy, ledger,
  hooks, turn and budget caps, full cost telemetry.
- Choose **Codex** if you want it for reasons of your own, and accept that the
  harness has fewer teeth on that path.

Codex enforcement parity is tracked work, not a shipped feature.

## Where the honesty is

- The capability matrix is a **declaration**, not a runtime probe. It describes
  what the integration supports, and it is kept honest by the refusal behaviour
  (a policy-armed project genuinely will not run on Codex) — but a declaration
  can still be wrong about the SDK underneath it.
- "Provider-agnostic core" describes the architecture, not feature parity. The
  seam is real; the two sides of it are not equally capable.
