# @noctcore/harness

A **portable Structure-Lock runner**. It reads a repo's `.nightcore/harness.json` and runs each
declared check, reddening the build on any violation — so a project's structure lock is enforced in
its **own CI**, with no Nightcore install, no server, and no account.

```bash
npx @noctcore/harness check
```

Run it from the repo root (or pass `--dir <path>`). If there is no `.nightcore/harness.json`, the
runner exits `0` — the lock is opt-in-by-presence.

## What it does

For every enabled check that declares a `command`, the runner prints the command, runs it in the
target directory (bounded by the check's `timeoutMs`, default 5 minutes), and records the outcome.
It runs **all** checks (it does not stop at the first failure), so one CI run shows the whole
failure set. It exits `0` when every check passed and `1` when any failed (printing a fix
instruction that lists each failed check with its command and captured output). `--json` emits a
machine-readable result to stdout instead.

```
harness [check] [--dir <path>] [--json] [--version] [--help]
```

## What it is NOT

- **Not a SaaS or telemetry.** The runner makes zero network calls at run time. Everything it reads
  is committed in your repo. It has zero runtime dependencies.
- **Not an integrity attestation.** It enforces **whatever checks are present** in your
  `.nightcore/harness.json` and your committed rule files. It does **not** verify that those files
  match what Nightcore originally generated — the artifacts are yours to edit. A weakened rule is
  enforced in its weakened form. The control against silent weakening is **PR review of the diff**
  (a re-export or a hand-edit shows up in `git diff`), not a signature or hash check.

The `command` strings in `.nightcore/harness.json` are executed. In your own CI this is the same
trust level as any `package.json` script or workflow step — your own committed, PR-reviewed config.
The runner prints every command before running it so a reviewer reading CI logs sees exactly what
executed.

## Requirements

Node ≥ 22.
