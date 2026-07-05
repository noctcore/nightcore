# Contributing to Nightcore

Thank you for your interest in Nightcore. This project is open source under the
[MIT License](LICENSE). By contributing, you agree that your contributions will
be licensed under the same terms.

Nightcore is an autonomous Claude dev studio: a desktop Kanban board where AI
agents implement tasks in isolated git worktrees. Bug fixes, features, docs, and
design polish are all welcome.

## Table of Contents

- [Before You Start](#before-you-start)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Pull Request Checklist](#pull-request-checklist)
- [Code Style & Architecture](#code-style--architecture)
- [Testing](#testing)
- [Reporting Issues](#reporting-issues)
- [Security](#security)
- [Code of Conduct](#code-of-conduct)

## Before You Start

Read these first — they are enforced by CI, not suggestions:

- [`AGENTS.md`](AGENTS.md) — import boundaries, package shape, naming, codegen rules
- [`docs/architecture.md`](docs/architecture.md) — runtime tiers and data flow
- [`docs/decisions/INDEX.md`](docs/decisions/INDEX.md) — active architectural decisions

### Prerequisites

- **[Bun](https://bun.sh) ≥ 1.1** (Node 22+ also works for libraries)
- **Rust toolchain** (stable) — for the Tauri core
- **[Claude CLI](https://code.claude.com/docs/en/setup)** — installed and authenticated locally
- **Git**

## Development Setup

```bash
git clone https://github.com/Shironex/nightcore.git
cd nightcore
bun install
bun run typecheck
bun run desktop    # full desktop studio (recommended)
```

Other useful entry points:

```bash
bun run web        # browser-only UI preview (sidecar disabled)
bun run sidecar    # raw NDJSON sidecar protocol
```

## Making Changes

1. **Fork** the repo and create a branch from `main`.
2. **Keep scope focused** — one logical change per PR when possible.
3. **Regenerate contracts** when you touch zod wire schemas:
   ```bash
   bun run codegen:contracts
   ```
   Never hand-edit generated Rust/TS contract files.
4. **Update the decision register** if you reverse an architectural choice
   (`docs/decisions/INDEX.md`).

### Branch naming

Use descriptive prefixes: `fix/…`, `feat/…`, `docs/…`, `refactor/…`.

## Pull Request Checklist

Before opening a PR, run the full gate locally:

```bash
bun run lint
bun run typecheck
bun run test:all
```

PRs should include:

- [ ] A clear summary of **why** the change is needed
- [ ] Tests for behavior changes (when applicable)
- [ ] Regenerated codegen output (if contracts changed)
- [ ] Decision-register update (if an arch decision changed)
- [ ] No live Claude sessions in tests — SDK boundaries must stay stubbed

CI runs the same checks on every push and pull request (see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Code Style & Architecture

- **Formatting:** `.editorconfig` is the authority for TS/JS (no Prettier/Biome).
- **Imports:** run `eslint . --fix` for `simple-import-sort` ordering.
- **Lint:** always `bun run lint` (never bare `eslint .`) — it rebuilds the
  eslint plugin and runs `lint-meta`.
- **Layer model:** `contracts → shared → storage → engine → surfaces`. Never import
  upward or sideways across packages.
- **SDK quarantine:** runtime `@anthropic-ai/claude-agent-sdk` usage lives only in
  `packages/engine/src/session/sdk-adapter.ts`.
- **Barrel imports:** use `@nightcore/<pkg>` only — no deep package subpaths.

See [`AGENTS.md`](AGENTS.md) for the full contract.

## Testing

| Command | What it runs |
|---------|----------------|
| `bun run test` | TS tiers only (Rust skipped) |
| `bun run test:all` | **Full gate** — build + node + web + plugin + Rust |
| `bun run test:rust` | Rust core + sidecar compile |
| `bun run test:web` | Vitest + Storybook component tests |
| `bun run test:node` | Bun tests across packages + sidecar |

- Node packages and `apps/sidecar` use **bun:test**.
- `apps/web` and `packages/eslint-plugin` use **Vitest**.
- Engine/sidecar tests **must stub** the SDK — no live `query()` calls.

## Reporting Issues

### Bug reports

Use the **[Bug Report](https://github.com/Shironex/nightcore/issues/new?template=bug_report.yml)**
template when filing on GitHub. Include:

- Nightcore version / commit SHA
- OS and Bun/Rust versions
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs (redact paths/tokens)

### Feature requests

Use the **[Feature Request](https://github.com/Shironex/nightcore/issues/new?template=feature_request.yml)**
template. Describe the workflow problem, not just the implementation. Link related
issues or decision docs if you have them.

## Security

Nightcore runs AI agents with filesystem and shell access on your machine. Treat
untrusted projects and task descriptions with care.

If you find a vulnerability, please **do not** open a public issue. Follow
**[SECURITY.md](SECURITY.md)** — use GitHub Security Advisories or contact
[@Shironex](https://github.com/Shironex) privately.

## Code of Conduct

All contributors are expected to follow our **[Code of Conduct](CODE_OF_CONDUCT.md)**.
Harassment or abusive behavior will not be tolerated.
