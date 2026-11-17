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
harness [check] [--dir <path>] [--manifest <path>] [--json] [--version] [--help]
harness lint-meta [--dir <path>] [--registry <path>]
harness catalog [--dir <path>] [--registry <path>] [--out <path>] [--check]
```

## Sync and async rules

A lint-meta rule declares `run(ctx)`, `runAsync(ctx)`, or both. Use `runAsync` when the check needs
an async API, such as ESLint's `calculateConfigForFile`:

```ts
import type { IMetaCtx, IMetaRule, IViolation } from '@noctcore/harness';

export const eslintConfigNoWarn: IMetaRule = {
  id: 'eslint-config-no-warn',
  category: 'config',
  ciCritical: true,
  description: 'ESLint severities must be "error" or "off", not "warn".',
  async runAsync({ root }: IMetaCtx): Promise<IViolation[]> {
    return checkResolvedConfigs(root);
  },
};
```

Rules run one at a time, in registry order. When a rule has both entry points, `run` goes first and
both report. A rejected `runAsync` is treated exactly like a throwing `run`: it is a critical failure
reported against that rule, and every later rule still runs. An object with neither entry point is
not a rule, and a registry that exports one fails to load.

## Generic rules (`@noctcore/harness/rules`)

The package also ships ready-made lint-meta rules for checks most repos want and ESLint cannot
reach. Each is a factory that takes the repo-specific parts as options and returns a strict rule
(`ciCritical: true`, no baseline). Install the package as a devDependency and add the rules to your
registry next to your own:

```ts
import type { IMetaRule } from '@noctcore/harness';
import {
  createGithubActionsSecretNoInstallRule,
  createLockfileRegistryResolutionsRule,
  createSingleVersionDependenciesRule,
} from '@noctcore/harness/rules';

import { myRepoRule } from './rules/my-repo-rule';

export const META_RULES: IMetaRule[] = [
  createLockfileRegistryResolutionsRule(),
  createSingleVersionDependenciesRule({ packages: ['typescript', 'react', 'react-dom'] }),
  createGithubActionsSecretNoInstallRule({
    exemptSecrets: [{ secret: 'CACHE_TOKEN', reason: 'the build cache credential; read-only on PRs' }],
  }),
  myRepoRule,
];
```

| Rule id | Category | Options | What it holds |
|---|---|---|---|
| `lockfile-registry-resolutions` | supply-chain | `lockfile` | Every package in the pnpm v9 lockfile resolves from the registry with a sha512 integrity hash: no git, tarball URL or directory source. |
| `single-version-dependencies` | supply-chain | `packages` (required), `lockfile` | Each listed package resolves to exactly one version in the lockfile. |
| `only-built-dependencies-have-scripts` | supply-chain | none | `onlyBuiltDependencies` and `ignoredBuiltDependencies` name exactly the installed packages that have a build step. |
| `pnpm-patch-ledger` | supply-chain | `ledger`, `lockfile`, `now` | Every `patchedDependencies` entry has a ledger entry with a reason, an upstream link, a removal condition and a `reviewBy` date that has not passed; the patch file hashes to what the lockfile records. |
| `github-actions-secret-no-install` | ci | `exemptSecrets` | A workflow job that can read a stored secret runs no package install. |
| `github-actions-security-no-cancel` | ci | `securityWorkflowName` | A security workflow never cancels a run or lets a new run replace a pending one. |

A config that would check nothing (an empty package list, an exemption with no reason) makes the
factory throw, so the registry fails to load instead of passing quietly. `RULE_IDS` lists every id
the subpath ships; a repo keeping a local rule should not reuse one.

The rules read the repo through the `IMetaCtx` the runner hands them, plus `node:fs` for the two
that inspect what is installed (`node_modules/.pnpm`) or hash a patch file. Like the rest of the
package they use `node:*` builtins only and make no network call.

## Rule catalog (`catalog`)

`harness catalog` renders a Markdown table of every rule in the registry: id, category, whether it
is CI-critical (a violation reds the build), and its description. It is generated from the registry,
so it cannot drift from what `lint-meta` enforces.

```bash
npx @noctcore/harness catalog                     # write RULES.md beside the registry
npx @noctcore/harness catalog --out docs/RULES.md # or anywhere, relative to --dir
npx @noctcore/harness catalog --check             # the gate: exit 1 + a diff when stale
```

The generated table sits between `<!-- harness:rule-catalog:start -->` and
`<!-- harness:rule-catalog:end -->`. If the file already has both markers, only the text between
them is replaced, so hand-written sections around the table survive. `--check` writes nothing; it
exits `1` when the committed file is missing or differs from what would be generated, and prints the
changed lines. The catalog only imports the registry; it never runs a rule.

## Pointing it at a bundle (`--manifest` / `--registry`)

A Nightcore **portable-lock bundle** commits its own command-translated manifest, so CI reads that
one file instead of the live `.nightcore/harness.json`:

```bash
npx @noctcore/harness check --manifest .nightcore/export/portable-lock/harness.json
```

The default paths are **opt-in-by-presence** (absent ⇒ exit `0`), but an **explicitly named**
manifest or registry is **fail-closed**: if the file you pointed at is missing (or the manifest is
unparseable), the runner exits `1`. A portable lock must never pass because the thing it was told to
enforce went missing.

## TypeScript rule registries

`lint-meta` loads a TypeScript registry as happily as a `.js` one — Nightcore's exporter emits
`registry.mts` and copies your generated rule files **verbatim** (it is deterministic Rust and never
shells out to a transpiler). The type stripping happens here, in the runner, using **Node's own**
(unflagged since Node 22.18) — which is why this package still has zero runtime dependencies. The
default registry lookup tries `.nightcore/lint-meta/registry.mts`, then `…/registry.ts`, then
`…/registry.js`.

Two requirements for a TypeScript registry: **Node ≥ 22.18**, and an ES-module scope. `.mts` (what
the exporter writes) is always an ES module; a plain `.ts` one is only ESM if the nearest
`package.json` says `"type": "module"`. Exported rules may only `import type` from `@noctcore/harness`: a
value import would have to resolve at run time, and nothing is installed in the target repo. A repo
that installs the package itself may import the `@noctcore/harness/rules` factories as values.

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

Node ≥ 22 (≥ 22.18 to load a TypeScript rule registry, which needs native type stripping).
