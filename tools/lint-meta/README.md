# tools/lint-meta

The repo's **meta-lint engine** — cross-file / non-JS governance rules that
ESLint can't express, run by `bun run lint:meta` (part of `bun run lint`) and
enforced in CI. A rule that reports a `ciCritical` violation fails the gate.

## Engine

```
cli.ts        entry point — builds a repo-rooted filesystem/exec context,
              runs every registered rule, prints violations, exits non-zero on
              any ciCritical violation (or a thrown rule)
registry.ts   META_RULES — the ordered list of rules the CLI runs; add here
types.ts      IMetaRule / IMetaCtx contracts (read/exists/glob/exec over root)
rules/        one file per rule (see below)
```

Run it directly:

```bash
bun run lint:meta   # == bun run tools/lint-meta/cli.ts
```

`lint-meta: no violations` on a clean tree means the gate is green.

### Adding / validating a rule

1. Write `rules/<my-rule>.ts` exporting an `IMetaRule` (`id`, `description`,
   `ciCritical`, `check(ctx)` → violations). Use the `ctx` seam
   (`read` / `exists` / `glob` / `exec`) — never touch the filesystem directly.
2. Register it in `registry.ts` (`META_RULES`).
3. Run `bun run lint:meta` — zero violations on a clean tree = valid.

## Rules

| id | what it enforces |
| --- | --- |
| `codegen-drift` | the zod→Rust `generated.rs` output matches `@nightcore/contracts` (`gen-rust-contracts.ts --check`) |
| `agent-contract-parity` | every wired `nightcore/*` lint rule is named in the agent-read-first `AGENTS.md` docs |
| `package-shape` | every workspace is `@nightcore/<dir>`; `packages/*` expose a single `src/index.ts` barrel + `dist/` build outputs |
| `workspace-graph-parity` | each `@nightcore/*` import is declared `workspace:*` and mirrored in tsconfig `references` |
| `layer-rank` | package imports only ever point strictly down the `contracts → shared → storage/skills → engine → surfaces` rank order |
| `no-warn-severity` | lint severity is `error` or `off`, never `warn` (a warning is a silent miss for agents) |
| `test-workspace-enrollment` | every node package with `*.test.ts` is enumerated in the `test:node` script (no untested package) |
| `test-runner-segregation` | node/TS + `apps/sidecar` use `bun:test`; `apps/web` + `packages/eslint-plugin` use Vitest — never mixed |
| `decision-register-integrity` | every path cited in `docs/decisions/INDEX.md` resolves and the register stays drift-free |
| `agents-doc-presence` | every deployable surface / public boundary ships an `AGENTS.md` |
| `ui-primitive-shape` | a `components/ui` primitive that graduates to a folder must ship `<Name>.test.tsx` + `<Name>.stories.tsx` |
| `rust-module-shape` | desktop Rust `mod.rs` is a manifest (declarations + re-exports only) + no code file exceeds 400 code lines (excluding `#[cfg(test)]` blocks); advisory until the phase-C ratchet grandfathers today's offenders, then enforced |
| `rust-layer-rank` | desktop Rust `crate::X` imports point strictly DOWN a 6-tier rank (contracts/infra/sync/engine_api → git → store/worktree/provider → analysis → engine SCC → commands), facades resolved + `#[cfg(test)]` stripped; the orchestration/sidecar/workflow SCC is co-tier except the banned `sidecar → orchestration` |
| `rust-command-placement` | no `#[tauri::command]` in the desktop leaf tier (`contracts`/`infra`/`sync`/`git`/`engine_api`/`store`/`worktree`/`provider`) — handlers live in `commands/` or a feature module |
| `rust-engine-seam` | nothing under `sidecar/**` references `crate::orchestration::` — the sidecar reaches the engine only through `Arc<dyn EngineApi>` |

The registry (`registry.ts`) is the source of truth if this table drifts.

## `layerRules` — the ESLint helper (secondary)

`index.mjs` is a small, separate flat-config helper (not part of the meta-lint
CLI). It exports a `no-restricted-imports` array (`layerRules`) wired into the
root `eslint.config.mjs` to enforce `apps/web` feature-folder boundaries:

1. **No cross-feature imports.** A file under `features/<A>/` may not import from
   `features/<B>/`. Shared code lives in `shared/`.
2. **Single Tauri seam.** Only `lib/bridge/` may import `@tauri-apps/api`; every
   other module goes through the bridge.
3. **`shared/` purity.** `shared/**` may not import from `features/*` and stays
   Tauri-agnostic.

```js
// eslint.config.mjs
import { layerRules } from './tools/lint-meta/index.mjs';

export default tseslint.config(
  // …existing config…
  ...layerRules,
);
```

It has no runtime dependency — it uses ESLint's built-in
`no-restricted-imports` so it works in the project's minimal flat config.
