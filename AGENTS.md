# Nightcore — Agent Contract

Read this before editing. These are hard guardrails, enforced by `bun run lint`, `bun run typecheck`, `bun run test:all`, and the `tools/lint-meta` engine. Severity is **error or off, never warn** — a rule that matters is an error; fix the failure, do not silence it.

## Repository shape
- Deployable surfaces live in `apps/*`; reusable libraries/capabilities in `packages/*`. Every workspace is named `@nightcore/<dir>` matching its folder, exposes a single `src/index.ts` barrel, compiles to `dist/`, and points `main`/`module`/`types`/`exports` at the built output.
- Allowed dependency direction: `contracts → shared → storage/skills → engine → surfaces`. Never import upward or sideways across that order (storage depends on shared, so shared ranks below storage; storage and skills are co-tier).

## Hard import boundaries
- The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) may ONLY be a dependency of `@nightcore/engine`. Its **runtime** API (`query()` and the session-store functions) is confined to `packages/engine/src/session/sdk-adapter.ts` — enforced by lint (`@typescript-eslint/no-restricted-imports` with `allowTypeImports`). Other engine modules may `import type` SDK shapes (e.g. `policy/permission-layer.ts`, `policy/question-layer.ts`, `policy/hook-bus.ts`) but never a runtime value. Every surface and capability package reaches the model through the `@nightcore/engine` façade. If a new package needs the model, route it through the engine — do not add an SDK dependency.
- Capability packages (`packages/skills`, peers) MUST NEVER import `@nightcore/engine`. The engine pulls capabilities in (dependency inversion), never the reverse.
- Cross-package imports use the package barrel `@nightcore/<pkg>` ONLY — never a deep subpath `@nightcore/<pkg>/...` into internals (enforced by `nightcore/no-deep-package-imports`). If a deep entry is truly needed, add an explicit `exports` subpath to that package.
- A package may only import workspace siblings it declares as `workspace:*` deps, and `tsconfig` `references` must mirror those edges. Add both in the same change.

## Contracts & codegen — regenerate, never hand-edit
- `@nightcore/contracts` (zod) is the single source of truth at the sidecar boundary and the dependency-graph leaf (zod only). Add new wire fields to the zod schema FIRST.
- Both contract boundaries are code-generated: zod→Rust via `tools/codegen/gen-rust-contracts.ts` (`bun run codegen:contracts`), and Rust serde→web TS via ts-rs (`cargo test`). NEVER hand-edit `apps/web/src/lib/generated/**` or `apps/desktop/src-tauri/src/contracts/generated.rs`. Change the schema/struct and regenerate.
- Persisted/wire structs are serde-additive: every new field is `Option` (Rust) / optional (zod) with a `None`/absent default in its own additive block, plus a field-absent pinning test. Never add a breaking required field.

## Naming
- Exported zod schema = PascalCase const suffixed `Schema`, paired with `export type Foo = z.infer<typeof FooSchema>` — enforced by `nightcore/zod-schema-naming` (`error` on `packages/contracts/src/**`). Discriminated-union *member* schemas intentionally use role suffixes `Event`/`Command`/`Query`, not `Schema`; the rule carves them out (their naming contract is `nightcore/wire-message-naming`).
- Wire field names are camelCase on BOTH sides; Rust structs serialized to the contract carry `#[serde(rename_all = "camelCase")]`.
- Message schemas: `<Noun><PastVerb>Event` / `<Verb><Noun>Command` / `<Verb><Noun>Query`; the wire `type` discriminant is the const name minus its role suffix, kebab-cased.
- Numeric Nightcore session id is `sessionId` (number); the SDK UUID is `sdkSessionId` (string). Never reuse one name for the other.

## Testing
- node/TS packages use `bun:test` (with `/// <reference types="bun" />`); `apps/web` and `packages/eslint-plugin` use Vitest. Never mix runners.
- The real gate is `bun run test:all` (it includes `test:rust`); plain `test` omits the Rust suite.
- The SDK/model boundary MUST be stubbed in engine tests — no live `query()` ever runs.

## Lint discipline
- Always run `bun run lint` (it rebuilds `@nightcore/eslint-plugin` to `dist/` first) — never a bare `eslint .`.
- Architectural boundaries are lint rules, not docs. A new legitimate cross-layer need adds a named seam (façade method / bridge command), it does not relax a rule.
- `.editorconfig` is the sole formatting authority for TS/JS (no Prettier/Biome; style beyond indent/EOL/final-newline is intentionally unenforced).
- Import ordering is enforced by `simple-import-sort/imports` + `/exports` (error, autofixable): side-effect imports → node/bun builtins → third-party → `@nightcore/*` + `@/` → relative, blank-line separated. Run `eslint . --fix` rather than hand-sorting.

## Enforced harness additions (lint-meta + plugin)

These guardrails are mechanical — `bun run lint` runs the ESLint plugin then `tools/lint-meta`. Severity is **error or off, never warn** (enforced by `no-warn-severity`).

- `nightcore/wire-message-naming` (ESLint, error on `packages/contracts/src/**`): a const ending `Event`/`Command`/`Query` whose zod object declares a `type: z.literal(...)` MUST set that literal to `kebab-case(constName minus its role suffix)` — e.g. `TaskCompletedEvent` → `'task-completed'`, `RunTaskCommand` → `'run-task'`.
- `package-shape` (lint-meta): every workspace is named `@nightcore/<dir>`; library packages expose `src/index.ts` and point `main`/`module`/`types`/`exports` at `./dist/`.
- `layer-rank` (lint-meta): the spine `contracts → shared → storage/skills → engine → surfaces` is enforced — a module may import only strictly-lower-ranked `@nightcore` packages; upward/sideways imports fail CI.
- `workspace-graph-parity` (lint-meta): every imported `@nightcore/*` must be a declared `workspace:*` dep, and `tsconfig` `references` must mirror those deps.
- `no-warn-severity` (lint-meta): no ESLint rule may be set to `'warn'` — error or off only.
- `test-workspace-enrollment` (lint-meta): a node package with `*.test.ts` must be listed in the `test:node` script.
- `test-runner-segregation` (lint-meta): `bun:test` for node packages + `apps/{cli,sidecar,tui}`; Vitest for `apps/web` + `packages/eslint-plugin`. Never mix runners.
- `decision-register-integrity` (lint-meta): every `docs/decisions/INDEX.md` row must carry a date and cite only paths that resolve on disk; every dated doc under `docs/decisions/` must be linked from a row.
- `agents-doc-presence` (lint-meta): an `AGENTS.md` must exist at the repo root, in every `apps/*`, and in every non-leaf `packages/*` (leaf packages are an explicit opt-out list in the rule).
- `ui-primitive-shape` (lint-meta): a `components/ui` primitive that graduates to a folder (own dir + `index.ts`) must ship `<Name>.test.tsx` and `<Name>.stories.tsx`; flat single-file primitives stay pure presentational.

Architectural decisions are recorded in `docs/decisions/INDEX.md` (status: active/superseded) — update the register in the SAME change that reverses a decision.