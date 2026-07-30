---
title: Architecture
description: Three tiers with hard process boundaries — a Rust orchestration core, a Bun provider sidecar that is the only place agent SDKs live, and a thin React client.
sidebar:
  order: 7
---

Nightcore is three tiers separated by **process** boundaries, not module
boundaries. The separation is the point: it is what makes "the SDK is
quarantined" a fact about the runtime rather than a convention.

```
┌──────────────────────────────────────────────────────────────┐
│  apps/web — React board (Tauri webview)                        │
│  Kanban UI. Talks ONLY Tauri commands + the event stream.      │
└───────────────▲───────────────────────────┬──────────────────┘
                │ invoke / events            │
┌───────────────┴───────────────────────────▼──────────────────┐
│  apps/desktop/src-tauri — RUST CORE (the orchestration brain)  │
│  task registry · auto-loop · worktrees · verification gates ·  │
│  guardrail battery · dependency resolver · event bus · IPC.    │
│  Provider-agnostic. Native, always-on, performance-critical.   │
└───────────────▲───────────────────────────┬──────────────────┘
                │ NDJSON over stdio          │ spawn + drive
┌───────────────┴───────────────────────────▼──────────────────┐
│  apps/sidecar — BUN PROVIDER SIDECAR (the only place agent     │
│  SDKs live). Wraps providers behind the Rust `AgentProvider`   │
│  trait; streams normalized events.                             │
└───────────────────────────────────────────────────────────────┘
```

## Why each boundary is where it is

### Rust + Tauri, not Electron

The orchestration loop, the gates, and every git operation are native Rust
running against the system webview — no bundled Chromium. The studio stays light
while driving several concurrent agent sessions, and the parts that must not be
talked out of anything (the state machine, the gates) are not running in the
same language or process as the model integration.

### The SDK is quarantined to one process

Agent SDKs exist in **exactly one process** — the Bun sidecar — behind a
provider seam. The core is provider-agnostic by construction: it speaks a
normalised event stream, not a vendor's API.

This is what makes [adding a provider](../providers/) a matter of implementing a
seam rather than rewriting orchestration, and it is why a surface (the UI) can
never reach an SDK: it would have to cross two process boundaries to do it.

### The UI is a thin client

The board talks to the core through Tauri commands and an event stream, and
nothing else. It holds no orchestration logic and no direct filesystem or
provider access.

## The boundaries are enforced, not aspirational

The claims above are checked in CI on every commit:

- Custom ESLint rules and a **meta-lint engine** enforce the package dependency
  spine (`contracts → shared → storage → engine → surfaces`) — an upward or
  sideways import fails the build.
- The Rust core has its own layer-rank rule with the same property.
- Both contract boundaries are **code-generated**: zod schemas → Rust, and Rust
  serde structs → TypeScript. CI regenerates and asserts no diff, so a schema
  that changed without regenerating is a failure rather than a runtime surprise.
- A drift-guard test proves that drift assertion still *trips* on a real change
  — because it once silently became a no-op, and a gate that cannot fail is
  worse than no gate.

Nightcore is governed by the same kind of harness it builds for your project.
The repository's own `AGENTS.md` is the contract, and CI enforces every rule in
it.

## Monorepo layout

```
apps/
  desktop/   Tauri 2 shell + src-tauri/ — Rust orchestration core & gates
  web/       React 19 + Vite + Tailwind — board UI
  sidecar/   Bun NDJSON server wrapping the agent SDKs
  docs/      this documentation site (Astro Starlight)
packages/
  contracts/ Zod schemas + types (the wire-protocol spine)
  engine/    session runner, policy hooks, sandbox, scans
  shared/ config/ storage/ session-fold/ eslint-plugin/ harness/
tools/       codegen, lint-meta, coverage
docs/        architecture, decisions, research
```

Nightcore grew out of the author's work on
[AutoMaker](https://github.com/AutoMaker-Org/automaker) and rebuilds that idea
from scratch: the same board-driven autonomy, re-architected onto hard process
boundaries and an enforcement-first harness.
