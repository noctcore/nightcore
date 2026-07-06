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
| `scan-family-parity` | scan-view families build on the shared `lib/useScanRun` + `lib/scan-run` primitives (no local re-declarations of `deriveRunPhase`/`useScanRun`/`seedStepState`); a new `components/<f>/<f>-stream.ts` must be consciously enrolled |
| `no-cloned-component-folders` | a component folder name exists under only ONE feature (`ui`/`app` excluded) — shared surfaces hoist to `components/ui`, divergent ones get a divergent name; today's clone groups (`RunControls` ×3, `CategoryTabs` ×2, `FindingDetailPanel` ×2) are frozen in a shrinking in-rule `ALLOWED_CLONES` allowlist (stale entries themselves fail) |
| `web-file-size-ratchet` | `apps/web/src` source files stay ≤400 raw lines (tests/stories/codegen excluded); today's 17 offenders are grandfathered by a shrinking `baselines/web-file-size-ratchet.json` (stale/shrunk entries themselves fail — self-tightening); companion in-editor cap = ESLint core `max-lines` at 500 with a freeze-at-worst carve-out — the two move together |
| `rust-module-shape` | desktop Rust `mod.rs` is a manifest (declarations + re-exports only) + no code file exceeds 400 code lines (excluding `#[cfg(test)]` blocks); enforced, with today's offenders grandfathered by a shrinking ratchet (`baselines/rust-module-shape.json`) — a new/grown offender fails |
| `rust-layer-rank` | desktop Rust `crate::X` imports point strictly DOWN a 6-tier rank (contracts/infra/sync/engine_api → git → store/worktree/provider → analysis → engine SCC → commands), facades resolved + `#[cfg(test)]` stripped; the orchestration/sidecar/workflow SCC is co-tier except the banned `sidecar → orchestration` |
| `rust-command-placement` | no `#[tauri::command]` in the desktop leaf tier (`contracts`/`infra`/`sync`/`git`/`engine_api`/`store`/`worktree`/`provider`) — handlers live in `commands/` or a feature module |
| `rust-engine-seam` | nothing under `sidecar/**` references `crate::orchestration::` — the sidecar reaches the engine only through `Arc<dyn EngineApi>` |

The registry (`registry.ts`) is the source of truth if this table drifts.

## Ratchet baselines (`baselines/`)

Some rules can't ship strict on day one because real, pre-existing offenders
exist (e.g. desktop Rust god-files over the `rust-module-shape` size cap). Rather
than weaken the rule, those offenders are **grandfathered** by a committed
`baselines/<rule-id>.json` — a flat `key → number` map freezing each offender at
its current metric. The ratchet is one-way (`baseline.ts`):

- a recorded offender **within** its frozen metric passes (grandfathered);
- a **new** offender, or a recorded one that **grew**, fails CI;
- as each offender is fixed, its entry is deleted (or lowered) — never raised.

A ratcheting rule implements the optional `baseline(ctx)` method (returns the
current offender map). Regenerate every baseline after a legitimate paydown with:

```bash
bun run lint:meta -- --update-baseline   # rewrites baselines/<rule-id>.json
```

Distinct from the ratchet are **permanent exemptions** encoded IN the rule
(`rust-module-shape` never counts `contracts/generated.rs`, `store/run_store.rs`,
`sidecar/harness/apply.rs`) — intentionally-whole files, not debt to pay down. The
baseline/ratchet mechanism is generic (`loadBaseline` / `isGrandfathered` /
`serializeBaseline` in `baseline.ts`) so other size/count ratchets can reuse it.

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
