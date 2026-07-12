# `@nightcore/harness` — agent contract

The **portable Structure-Lock runner**. A thin, published CLI (`npx @nightcore/harness check`)
that enforces a repo's `.nightcore/harness.json` `checks[]` in any CI, with **no Nightcore
install**. This is `check` PR 1 of the portable-lock series (issue #134); it is a faithful Node
port of the in-process Rust runner in `apps/desktop/src-tauri/src/workflow/gauntlet_project/`
(`config.rs` = load + plan, `runner.rs` = execute).

## Hard constraints — read before editing

- **Plain Node ≥ 22 only.** This package is published and runs under plain `node` in strangers'
  CI. Use `node:*` builtins only (`node:fs`, `node:child_process`, `node:path`, `node:process`,
  `node:url`). **Never import `bun` / `bun:*` in `src/` (non-test) code** — the monorepo runs on
  Bun, but the shipped artifact must not. `src/*.test.ts` files DO use `bun:test` (the repo's
  node-package test runner); that is correct and required by `test-runner-segregation`.
- **Zero runtime dependencies.** No `dependencies` in `package.json`. The strongest supply-chain
  posture: nothing to audit, nothing to pin. `src/cli.node.test.ts` asserts the built `dist` imports
  no `http`/`https`/`net`/`dns`/`tls`/`bun` and makes no `fetch()` call — keep it green.
- **No network at run time.** The runner reads only what is committed in the target repo. No
  telemetry, no rule-fetching, no self-update.
- **Own build.** This package ships its own `tsup` `dist` (unlike `@nightcore/engine`, which the
  root `tsc -b` builds). A `files: ["dist"]` allowlist + the `build` script are load-bearing.
- **`private: true` for now.** Un-privating + the publish pipeline are a later PR (PR 4).

## Behavior (parity target: the LIVE Rust runner)

- **FULL-RUN**, not stop-at-first: every enabled check with a command runs; every outcome is
  recorded. `passed` is false iff any check failed; `failedCheck` names the first failure. On
  failure the CLI prints a `fixInstruction` listing **all** failed checks. This matches the live
  `runner.rs` (its doc comment explains why a fix session should see the whole failure set) — the
  same rationale applies to a human reading CI. The Nightcore-only machinery (retry/flaky, the
  security no-retry exclusion, drift substrates, task verify-append) is intentionally **dropped**:
  it has no CI meaning. Statuses are only `passed` / `failed`.
- **Per-check timeout kept.** Honor `timeoutMs` when `> 0`, else 300000 ms (`DEFAULT_CHECK_TIMEOUT`).
  A timeout is a **failed** check (fail-closed — never a silent pass).
- **Check selection** (`plan_check` parity): a check runs iff `enabled !== false` AND `command` is a
  non-blank string. `kind: "shell"` is skipped (its execution is a deferred fast-follow). Any other
  kind (including an unknown/future one) with a command runs — the runner treats everything except
  `schemaVersion` as data.
- **opt-in-by-presence:** absent / unreadable / malformed-JSON / no-`checks`-array ⇒ exit 0.
- **`schemaVersion` gate:** absent ⇒ 1; equal-or-lower MAJOR proceeds; a higher/unknown MAJOR reds
  the build (upgrade the runner) — the only field the runner interprets structurally.
- **Legibility:** every command is printed before it runs (stdout in the human path, stderr under
  `--json` so stdout stays a single parseable document).

## Layout

- `src/manifest.ts` — the port of `config.rs` (load + plan), pure over an injected `FileReader`.
- `src/run.ts` — the port of `runner.rs` (full-run execute + `fixInstruction`), pure over an
  injected `SpawnFn`.
- `src/cli.ts` — arg parse + subcommand dispatch (`check` [default], `--json`, `--dir`, `--help`,
  `--version`). `runCli(argv, io)` is pure over an injected `CliIO`; the module self-invokes only as
  the `harness` bin (a symlink-safe entry check). The `lint-meta` subcommand is PR 2 — unregistered.
- `src/index.ts` — the public type barrel (manifest + result shapes). PR 2 adds the lint-meta
  contract here.

## Tests + gate

`bun:test`, enrolled in the root `test:node` script (and the `check-node-coverage.ts` SUITE, so CI
actually runs them). Run before declaring work done:

```
bun run --filter @nightcore/harness build
node packages/harness/dist/cli.js --version   # must run under plain node
bun run test:node
bun run lint:meta                             # package-shape / workspace-graph / enrollment / segregation
```
