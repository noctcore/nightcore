---
title: Files on disk
description: Exactly where Nightcore keeps state — the per-project .nightcore directory, the global config directory, and the log file.
sidebar:
  order: 6
---

Nightcore is local-first: there is no server and no database. Everything it
knows is a file you can open, and this page says which.

## Per-project — `<project>/.nightcore/`

Created when you open a project. This is the directory that matters.

| Path | What it is |
|---|---|
| `.nightcore/harness.json` | **The one file you author.** Structure-Lock `checks[]` and the runtime `policy` block. See [Enforce](../../lifecycle/enforce/) and [Policy](../../governance/policy/). |
| `.nightcore/ratchet.json` | The strictness ratchet baseline (`any` / `@ts-ignore` / `eslint-disable` counts). |
| `.nightcore/tasks/` | One `<taskId>.json` per board task, plus a per-task transcript. |
| `.nightcore/ledger/<taskId>.ndjson` | The [flight recorder](../../governance/receipts/) — every tool decision for that task. |
| `.nightcore/ledger/project.ndjson` | The [governance journal](../../governance/receipts/) — policy saves, arm/disarm, ratchet snapshots. |
| `.nightcore/ledger/.gitignore` | A self-ignoring `*`, written on first use, so governance history never becomes a commit by accident. |
| `.nightcore/insights/`, `.nightcore/harness/`, `.nightcore/scorecards/` | Scan run stores, one directory per scan family. |
| `.nightcore/worktrees/` | Per-task worktree state. |
| `.nightcore/terminals/` | Persistent terminal session state. |

### The manifest

`.nightcore/harness.json` is the only file here you are expected to edit — and
mostly you will edit it through the app rather than by hand.

```jsonc
{
  "schemaVersion": 1,
  "checks": [
    { "name": "structure-lock", "kind": "lint-meta",
      "command": "bun run lint:meta", "enabled": true }
  ],
  "policy": {
    "enabled": true,
    "protectedPaths":   ["migrations/**"],
    "denyBashPatterns": ["--no-verify"],
    "denyReadPaths":    [".env*"],
    "disallowedTools":  ["WebSearch"],
    "askTools":         ["WebFetch"],
    "allowTools":       ["Bash(git status:*)"],
    "allowExecSinks":   [".github/workflows/**"],
    "diffBudget": { "maxChangedLines": 400, "maxChangedFiles": 20 }
  }
}
```

Behaviours worth knowing:

- **No key is required.** An absent file reads as "nothing armed". `{"checks":[]}`
  reads as an armed-but-empty policy — which still gives you the implicit
  `.nightcore/**` self-protection.
- **Unknown keys survive a round-trip.** Editing policy through the app preserves
  every key it does not understand, at every level.
- **A malformed manifest is a hard error, and the file is preserved byte for
  byte.** Nightcore will not "fix" your manifest by rewriting it.
- `allowExecSinks` has **no UI controls** — it is hand-edit only.

### Should you commit `.nightcore/`?

The general answer is: commit `harness.json` if you want your rules to travel
with the repo (CI can then enforce the same structure lock), and ignore the
rest. The `ledger/` directory ignores itself already. Run stores, task state,
worktree and terminal state are all machine-local.

## Global — the app config directory

Nightcore's cross-project state lives in the OS per-user application directory
for the identifier `dev.shirone.nightcore`:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/dev.shirone.nightcore/` |
| Windows | `%LOCALAPPDATA%\dev.shirone.nightcore\` |
| Linux | `$XDG_DATA_HOME/dev.shirone.nightcore/` (or `~/.local/share/...`) |

It contains:

- `settings.json` — global defaults plus a per-project overrides map. This file
  holds plaintext MCP `env` / `headers` values, so it is written **owner-only
  (`0600`)**. Treat it as a secrets file.
- `projects.json` — the registry of projects you have opened.
- `active.json` — which project is active.

A corrupt registry file resets to empty rather than aborting startup.

## Logs

A daily-rolling `nightcore.log` is written to the platform log directory (on
macOS, `~/Library/Logs/dev.shirone.nightcore/`), so a bundled app launched from
Finder — with no terminal attached — still produces diagnosable output.

## Things Nightcore does *not* write

- No credentials. It never writes an API key, and it never reads one out of your
  provider CLI's storage. See [Providers](../providers/).
- Nothing in your repository, except: commits inside a task's worktree, and
  Harness artifacts you explicitly apply.
