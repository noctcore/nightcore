---
title: Install and connect a provider
description: Platform support, prerequisites, provider authentication, and how to build from source.
sidebar:
  order: 2
---

## Platform support, honestly

| Platform | Status |
|---|---|
| **macOS** (Apple Silicon + Intel) | Installers published (`.dmg`), signed in-app auto-update. The only platform where the OS-level Seatbelt sandbox exists. |
| **Windows** | Installers published (`setup.exe` / `.msi`), signed in-app auto-update. No OS sandbox module. |
| **Linux** | Best-effort. **No installer is built** — the release pipeline targets macOS (`aarch64-apple-darwin`, `x86_64-apple-darwin`) and Windows only. Build from source. |

Nightcore is **alpha**. APIs, UI, and on-disk formats can break between
releases. See [Limits and honest gaps](../../reference/limits/) for the full
list of what is unfinished, unverified, or platform-specific.

## Install a release

Grab the latest build from the
[releases page](https://github.com/noctcore/nightcore/releases/latest). Signed
in-app auto-update is built in, so subsequent versions arrive without a
re-download.

## Prerequisites: a provider CLI you already own

Nightcore has **zero credential code**. It does not bundle an API key, does not
proxy your traffic, and never passes an `apiKey` to a provider SDK. It drives
the CLI installed on your machine and lets that CLI resolve its own credentials.

That means the one real prerequisite is a working, logged-in provider CLI.

### Claude (default provider)

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude   # log in once
```

Credentials resolve the way the CLI resolves them (`~/.claude`). If
`ANTHROPIC_API_KEY` is present in the inherited environment it is honoured as a
fallback, but the intended path is your local login.

### Codex (optional second provider)

Install the Codex CLI and sign in (`codex login`), or set `CODEX_API_KEY`.
Select Codex in Settings.

Codex runs behind the same provider seam as Claude but **declares a smaller
capability set**, and Nightcore respects those declarations rather than
pretending: no hooks, no Harness policy layer, no ledger, no turn or budget
caps, token-only cost telemetry. Because the policy layer is unavailable, a run
against a project whose Harness policy is **armed is refused outright** rather
than run ungoverned. The full matrix is in
[Providers](../../reference/providers/) — read it before choosing Codex for
governed work.

:::caution
Codex's declared limits are not cosmetic. If you rely on Nightcore's governance
surfaces, Claude is currently the provider that supports them.
:::

## Build from source

Additional prerequisites:

- **[Bun](https://bun.sh) ≥ 1.1** — the sidecar and the TypeScript workspace
- **Rust toolchain** — to build the Tauri core

```bash
git clone https://github.com/noctcore/nightcore.git
cd nightcore
bun install
bun run desktop      # Tauri dev — the full studio
```

Verify the workspace:

```bash
bun run typecheck
bun run test:all     # the full gate, including the Rust suite
```

`bun run web` starts a browser-only UI preview with the sidecar disabled — it is
useful for looking at the interface, not for running agents.

## Before you point it at a repo

Nightcore runs agents with access to your filesystem and shell. Two things are
worth doing on day one:

1. **Start on a repo you trust**, and preferably one under version control with
   a clean working tree. Agent work happens in a separate worktree, but the
   project root is still readable.
2. **Read [How a change earns its merge](../../governance/gates/)** so you know
   what does and does not happen automatically before you enable Auto Mode.

Then go to [Your first task](../first-task/).
