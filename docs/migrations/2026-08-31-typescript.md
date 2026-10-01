# Migration Plan: typescript 5.9.3 -> (retargeted) 6.0.3, NOT 7.0.2

**Date:** 2026-08-31
**Agent:** kirei-migrate
**Base branch:** `deps/phase-1-safe-bumps` (PR #465, open) — plan stacks on this branch's already-refreshed `bun.lock`. Do NOT plan against `main`.
**Target:** `typescript` `5.9.3` -> `6.0.3` (recommended, do now) — **`7.0.2` explicitly deferred, not recommended today**
**Supersedes / relationship to Dependabot PR #418:** PR #418 proposes `5.9.3 -> 7.0.2` directly. Left untouched per instructions. This plan does **not** adopt it — see "Why not 7.0.2" below. PR #418's own CI is empirical confirmation of the blocker (see below).
**Migration guides read:** TypeScript 6.0 announcement (devblogs.microsoft.com/typescript/announcing-typescript-6-0), TypeScript 6.0 release notes (typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html), TypeScript 7.0 GA coverage (InfoQ 2026-08, Visual Studio Magazine 2026-06-22 RC coverage), typescript-eslint issue #12518 ("TypeScript 7.0.2 Support", closed not-planned), typescript-eslint issue #12123 ("TypeScript 6 Support").

## Summary

**Do not adopt Dependabot PR #418 (typescript 7.0.2) yet.** TypeScript 7.0 is the GA native/Go-ported compiler (shipped under the `typescript` npm package itself at major version 7, not a separate `@typescript/native-preview` package — that preview package still exists separately and is unrelated). It ships **with no classic programmatic Compiler API**: the package's root export `"."` now points at `./lib/version.cjs` (verified by unpacking the real npm tarball), which contains only:
```js
const { version } = require("../package.json");
exports.version = version;
exports.versionMajorMinor = "7.0";
```
Compare TypeScript 5.9.3 / 6.0.3, whose root export is `./lib/typescript.js` — the full `ts.createProgram`/`ts.createSourceFile`/`ts.SyntaxKind`/checker API. TS 7.0.2 replaces that with a new, explicitly `unstable/*`-namespaced, async/sync JSON-RPC client API (vendored `vscode-jsonrpc`) that talks to the native `tsgo` binary — a different architecture entirely, not a superset.

This is fatal for this repo today because:
1. **`typescript-eslint` (all 8.x releases through the current latest, `8.68.0`, checked live via npm on 2026-08-31) hard-excludes TypeScript 7** via peer dependency `"typescript": ">=4.8.4 <6.1.0"` on every sub-package (`typescript-eslint`, `@typescript-eslint/parser`, `@typescript-eslint/utils`, `@typescript-eslint/rule-tester`, `@typescript-eslint/typescript-estree`). A GitHub issue asking for 7.0.2 support (typescript-eslint#12518, opened GA day) was **closed as "not planned."** `eslint.config.mjs` imports `typescript-eslint` (`tseslint`) and applies it across effectively every `.ts`/`.tsx` file in the repo — so `bun run lint` (root `eslint .`) breaks repo-wide, not just at a few call sites.
2. **This repo's own codegen has a first-party, concrete call site that hard-crashes under TS 7**: `tools/codegen/gen-settings-scope.ts:40` does `import ts from 'typescript'` and then calls `ts.createSourceFile`, `ts.ScriptTarget.Latest`, `ts.isTypeAliasDeclaration`, `ts.isTypeLiteralNode`, `ts.isPropertySignature`, `ts.isIdentifier` — none of which exist on the TS 7.0.2 root export. Under TS 7 this throws `TypeError: ts.createSourceFile is not a function` the moment `bun run codegen:settings-scope` (or `codegen:check`, which chains it) runs.
3. `tsup --dts` (used by `packages/eslint-plugin` and `packages/harness` builds, `bun run lint:plugin`) plausibly depends on the classic Compiler API for declaration-file generation. tsup's own peer range (`typescript: ">=4.5.0"`) does nothing to protect against this — unverified in a live run, but a real additional risk on top of (1) and (2).
4. **Empirical confirmation**: PR #418's own CI (`gh pr checks 418`) is already red — `lint · typecheck · test (Bun workspace)` **fails**, `proof` **fails**, `vitest browser coverage (apps/web)` **fails** — exactly the blast radius predicted by (1). Rust jobs pass (Rust doesn't touch the JS `typescript` package).
5. The ecosystem itself isn't ready: Microsoft ships a separate `@typescript/typescript6` compat shim (wraps `typescript@^6` under a `tsc6` binary, `npmjs.com/package/@typescript/typescript6`) specifically so tools that still need the classic API can keep working while `tsc` itself moves to 7 — an industry-wide acknowledgment that tools like ESLint aren't ready yet, not a nightcore-specific gap.
6. TypeScript 7.1 (expected to restore a *stable* programmatic API) has **not shipped as stable** as of this research (2026-08-31): `npm view typescript dist-tags` shows only prerelease builds (`next: 7.1.0-dev.20260831.1`), no `7.1.0` GA tag. Even once it ships, typescript-eslint would need its own follow-up release adopting the new API shape (a rewrite of `@typescript-eslint/typescript-estree`'s AST-conversion layer against an async/sync RPC client instead of an in-process object graph) — not a quick peer-range widening.

**Recommended target for this migration: TypeScript `6.0.3`** — the final and only stable point release on the 6.x line (versions on npm: `6.0.0-beta`, `6.0.1-rc`, `6.0.2`, `6.0.3`, then straight to `7.0.1-rc`/`7.0.2` — there is no 6.1, 6.2, etc.; 6.x was explicitly a short transitional major to surface 7.0's deprecations as warnings first). TS 6.0.3:
- **Is inside typescript-eslint's supported peer range** (`>=4.8.4 <6.1.0`) — confirmed via live npm peer-dependency check against both the currently-locked `8.61.1` and the latest `8.68.0`. No typescript-eslint bump is *required* to move to 6.0.3.
- **Still ships the classic Compiler API** (`lib/typescript.js`, verified by unpacking the real 6.0.3 tarball) — `gen-settings-scope.ts` and `tsup --dts` keep working unmodified.
- Gets most of the practical benefit of "moving off 5.9.3" (current deprecation warnings, `--stableTypeOrdering`, TC39 stage-4 lib types) without the ecosystem cliff.
- This repo's tsconfigs are already unusually well-aligned with TS 6's new defaults (see Breaking Changes table) — the actual mechanical footprint is one config line.

This is a **single-PR, mechanical + one small behavioral-verification pass** migration — not a multi-week effort. The riskiest item is a new default (`noUncheckedSideEffectImports: true`) that needs an actual `tsc -b` run to confirm it doesn't surface latent side-effect-import errors, not a design risk.

## Pre-flight Requirements

- Runtime: no change. `engines.node: ">=22"` in root `package.json` already exceeds TS 6.0.3's own requirement (`node >=14.17`) and TS 7.0.2's (`node >=16.20.0`) — not a blocker either way.
- Peer deps: none need bumping to move to 6.0.3 (typescript-eslint 8.61.1, already locked, already covers `<6.1.0`).
- Base branch state: must build on `deps/phase-1-safe-bumps` (PR #465)'s `bun.lock`, not `main`'s. Verify `git merge-base` / branch-off point before starting execution.

## Breaking Changes & Call Sites (TypeScript 6.0, vs. current 5.9.3)

### BC-1 — `baseUrl` deprecated as a module-resolution lookup root
**Type:** Structural (config), trivially mechanical fix
**What changed:** "In TypeScript 6.0, `baseUrl` is deprecated and will no longer be considered a look-up root for module resolution." (6.0 emits a warning; full removal lands in 7.0.)
**Call site:** `apps/web/tsconfig.json` — sets `"baseUrl": "."` alongside `"paths": { "@/*": ["./src/*"] }`.
**Fix:** Delete the `"baseUrl": "."` line, keep `paths` as-is. Under `"moduleResolution": "bundler"` (already set here), `paths` resolves relative to the tsconfig file's own directory without needing `baseUrl` — and `baseUrl` was already `"."` (the tsconfig's own directory), so this is behavior-neutral, not a real remap.
**No other tsconfig in the repo sets `baseUrl`** (checked all 12: `tsconfig.base.json`, `apps/{docs,sidecar,web}/tsconfig.json`, `packages/{config,contracts,engine,eslint-plugin,harness,session-fold,shared,storage}/tsconfig.json`).

### BC-2 — New default: `noUncheckedSideEffectImports: true`
**Type:** Behavioral — genuinely needs a real `tsc -b` run, not just a read
**What changed:** TS 6.0 flips this default from `false` to `true`. It flags side-effect-only imports (`import './foo'`) where TypeScript can't resolve any matching declaration for the target module.
**Call sites:** Not enumerable by grep alone — this is a compiler-wide behavioral check across every side-effect import in `apps/web` (CSS imports, polyfill-style imports) and any Node-side package. `apps/web/tsconfig.json` already includes `"types": ["vite/client", ...]`, which should declare `*.css`/asset side-effect imports correctly, but this must be confirmed by actually running the typecheck, not assumed from reading config.
**Fix:** Run `bunx tsc -b apps/web` and root `bun run typecheck` after the bump; if new errors appear here, they are either (a) legitimate typos/dead imports worth fixing, or (b) need a per-file `// @ts-expect-error` / ambient `.d.ts` declaration for a genuinely side-effect-only import with no types (e.g. some CSS-in-JS or global polyfill). Do not blanket-disable the flag without inspecting what it caught — this is exactly the class of check the option exists to add.

### BC-3 — Other TS 6.0 hard removals / deprecations — checked, **none apply**
Grepped the whole JS/TS tree (`apps`, `packages`, `tools`, `scripts`) for every item on the 6.0 removal/deprecation list:
- `moduleResolution: classic` / `node` (node10) — repo uses `bundler` everywhere. Not present.
- `module: amd/umd/systemjs/none` — repo uses `ESNext` everywhere. Not present.
- `outFile` — not set anywhere.
- Legacy `module Foo {}` namespace syntax — no matches.
- Old import-assertion syntax (`assert { type: ... }`) — no matches (repo uses `verbatimModuleSyntax: true`, would already require the modern `with` keyword if this pattern existed).
- `/// <reference no-default-lib="true"/>` — no matches.
- `tsc <file>` invocation style that now errors when a `tsconfig.json` is present — every `package.json` script uses `tsc -b` or bare `tsc --noEmit` (reads the config, no stray file args). Not present.
- `downlevelIteration` — not set anywhere.
- `esModuleInterop: false` / `allowSyntheticDefaultImports: false` (can no longer be set to `false`) — repo already sets both `true` explicitly in `tsconfig.base.json`. Already aligned.
- `alwaysStrict: false` (no longer settable) — repo sets `strict: true` everywhere (implies `alwaysStrict: true`). Already aligned.
- `strict`/`module`/`target`/`types` default flips — repo already explicitly sets `strict: true`, `module: "ESNext"`, `target: "ES2022"`, and an explicit `types: [...]` array in every workspace tsconfig (or `types: []` in `packages/session-fold`). The new TS 6.0 defaults for all of these already match what the repo has hand-set — zero default-reliance risk.
- `rootDir` default change (now defaults to the tsconfig's own directory instead of being inferred from included files) — every package with `outDir`/emit sets `rootDir: "src"` explicitly already. `apps/web`, `packages/eslint-plugin`, `packages/harness` don't set `rootDir`, but all three have `noEmit: true` (or no `outDir`), so the new default has no observable effect (nothing is emitted based on it).

## Interaction With CI Gates

| Gate | Risk | Why |
|---|---|---|
| `bun run typecheck` (root `tsc -b`) | Low, but must actually run | BC-1/BC-2 above are the only live risk; project references / `--build`/incremental mode are unaffected by TS 6.0 per the release notes ("API Stability Notes" section makes no mention of project-reference changes). |
| `bunx tsc -b packages/engine`, `bunx tsc -b apps/web` (explicit extra CI steps in `.github/workflows/ci.yml`, `bun-checks` and `rust-checks` jobs) | Low | Same as above — these are the exact commands that will surface BC-2 if it fires. |
| `bun run lint` (`eslint .` via `typescript-eslint`) | **This is the one that matters** | Confirmed compatible: `typescript-eslint@8.61.1` (currently locked) already declares `typescript: ">=4.8.4 <6.1.0"` — 6.0.3 is inside range. No version bump strictly required, but see the typescript-eslint companion-bump recommendation below for why to do one anyway. |
| `lint:meta` (`tools/lint-meta`, Bun-based custom rule runner) | None | Confirmed: no rule in `tools/lint-meta/rules/*.ts` imports `typescript` or `typescript-eslint` directly; the one codegen-sensitive rule (`codegen-drift.ts`) only shells out to `gen-rust-contracts.ts` (zod-only, no TS Compiler API — see codegen section below). |
| `test:node` / `test:web` / `test:plugin` | Low | None of vitest, `@vitest/browser`, or `vitest-browser-react`'s TS handling goes through the `typescript` package's Compiler API for transforms (esbuild/oxc-based); `packages/eslint-plugin`'s `test:plugin` uses `@typescript-eslint/rule-tester`, covered by the typescript-eslint compatibility check above. |
| `test:rust` / `cargo test` (ts-rs emit) | None | `ts-rs` is a Rust crate (`Cargo.toml: ts-rs = "12.0"`) that emits `.ts` binding files as plain text from Rust — it has zero dependency on the npm `typescript` package. Verified by `cargo test` regenerating bindings independent of the JS toolchain. |
| File-size ratchet (`web-file-size-ratchet.ts`, `engine-file-size-ratchet.ts` in `lint:meta`) | None | Pure line-count rules over committed files; unrelated to the compiler version. |

## Interaction With the Two-Way Codegen (zod<->Rust, ts-rs->TS)

- **zod -> Rust** (`tools/codegen/gen-rust-contracts.ts`, gated by `lint:meta`'s `codegen-drift` rule, CI-critical): imports only `zod` + Node builtins. **Zero interaction** with the `typescript` package at any version.
- **Rust -> TS via ts-rs** (`cargo test` regenerates `.ts` binding files under `apps/web/src/lib/generated/`, gated by `verify:drift-guard` in the Rust CI job): pure Rust-side codegen emitting text. **Zero interaction** with the npm `typescript` package.
- **The one real interaction point**: `tools/codegen/gen-settings-scope.ts` (`bun run codegen:settings-scope`, chained inside `bun run codegen:check` as its 3rd step) *parses* the ts-rs-generated `SettingsOverride.ts` binding using the TypeScript Compiler API (`ts.createSourceFile` etc.) to derive the per-project-overridable settings keys. This is the concrete BC-2/TS-7-blocker call site described above.
  - **Under the recommended TS 6.0.3 target: unaffected**, classic API still present.
  - **Side note, not part of this migration's scope**: `codegen:check` (and therefore `gen-settings-scope.ts --check`) is **not currently wired into any CI job, `lint:meta` rule, or husky hook** — checked `.github/workflows/*.yml`, `tools/lint-meta/rules/*.ts`, `.husky/pre-commit`, `.husky/pre-push`, `scripts/check-rust.ts`, `scripts/verify-drift-guard.ts`. It's a manually-run generator today. This means a future TS 7 attempt wouldn't fail CI here — it would fail silently (a developer's local `bun run codegen:settings-scope` run throwing a `TypeError`) instead. Worth a follow-up ticket to wire `codegen:settings-scope --check` into `lint:meta` regardless of the TS version question, but that's out of scope for this migration.

## Companion Bump: typescript-eslint / `@typescript-eslint/*`

**What the new TypeScript (6.0.3) requires:** nothing — `typescript-eslint@8.61.1` (currently locked via the bounded override `@typescript-eslint/utils: ">=8.61.1 <8.62.0"` in root `package.json`) already declares peer support for `typescript: ">=4.8.4 <6.1.0"`, which covers 6.0.3.

**What this migration should still do, to satisfy the stated goal of removing the override:** The override was added in the immediately-preceding commit (`07388dfa`, current HEAD of `deps/phase-1-safe-bumps`) as **deliberate scope-holding**, not a TS-compatibility guard — its own commit message says it's "held at 8.61.1 via a bounded override, matching the report's own Phase 2 entry for this exact transition," referring to `docs/deps/2026-08-31-dependency-upgrade-plan.md`'s Phase 2 entry: `@typescript-eslint/utils / parser / rule-tester: 8.61.1 -> 8.68.0 minor ... run bun run lint, bun run lint:meta, and bun run test:plugin explicitly`. That Phase 2 bump was deferred, not blocked.

Since this TypeScript migration already requires a full `bun run lint` / `lint:meta` / `test:plugin` re-verification pass anyway, it is the natural vehicle to complete that deferred Phase 2 bump **in the same PR**, and then delete the override:
1. Bump `@typescript-eslint/utils` (root override target + `packages/eslint-plugin` dependency), `@typescript-eslint/parser`, `@typescript-eslint/rule-tester` (both `packages/eslint-plugin` devDependencies) from `8.61.1` -> `8.68.0` (latest as of 2026-08-31; same peer range `>=4.8.4 <6.1.0`, confirmed compatible with the new TS 6.0.3).
2. Bump root `typescript-eslint` (the flat-config meta-package, currently `^8.0.0`/locked `8.61.1`) to `^8.68.0` / `8.68.0` to match.
3. Delete the `"@typescript-eslint/utils": ">=8.61.1 <8.62.0"` line from root `package.json`'s `overrides` block entirely — its scope-holding purpose is now fulfilled by an actual reviewed+verified bump, not a version freeze.
4. Verify explicitly: `bun run lint` (full `eslint .`), `bun run lint:meta`, `bun run test:plugin` (the `@typescript-eslint/rule-tester`-based suite in `packages/eslint-plugin`) — these are the exact three checks the dependency-upgrade-plan doc already prescribed for this bump, independent of the TypeScript version question.

**`@eslint/js` — confirmed NOT interacting with this migration.** It supplies base *JavaScript* recommended-rule configs (`js.configs.recommended` in `eslint.config.mjs`), which is orthogonal to `typescript-eslint`'s TypeScript-specific parser/rules. Its own drift (`^9.0.0` pinned while `eslint` itself is on v10) is a pre-existing, unrelated Phase-4 backlog item from the dependency-upgrade-plan doc — leave untouched here to keep this PR's diff scoped to the TypeScript transition.

**Other `@types/*` / runners:** `@types/node`, `@types/bun` need no change (declaration-only packages, not TS-Compiler-API-version-sensitive across a single major). `tsup@8.5.1`'s own peer (`typescript: ">=4.5.0"`) is permissive and does not need a bump for 6.0.3 (it still gets the classic API). `vitest@3.2.7` has no direct `typescript` peer dependency at all (TS transform is esbuild/oxc-based, not through the `typescript` package) — no change needed.

## Codemods Available

None. TypeScript itself does not publish a codemod for the 5.x -> 6.0 transition (it's a config-and-defaults release, not an API-rename release); the one concrete fix (BC-1, dropping `baseUrl`) is a one-line manual edit, not codemod-worthy. TypeScript does ship `"ignoreDeprecations": "6.0"` as an escape hatch to silence 6.0's own deprecation warnings temporarily, but this repo doesn't need it — checked all tsconfigs, none carry a pre-existing `ignoreDeprecations` entry, and the one live deprecation (BC-1) has a real fix available immediately rather than a reason to suppress.

## Upgrade Order

1. Confirm branch base: work on top of `deps/phase-1-safe-bumps` (PR #465)'s current `bun.lock` state — do not rebase onto `main`'s older lockfile.
2. Edit `apps/web/tsconfig.json`: remove `"baseUrl": "."` (BC-1). Keep `paths` unchanged.
3. Bump `typescript` `^5.9.3` -> `^6.0.3` (or an exact `6.0.3` pin, matching the repo's existing pin style for `zod`) in the 4 manifests that declare it directly: root `package.json`, `apps/web/package.json`, `packages/eslint-plugin/package.json`, `packages/harness/package.json`.
4. In the same PR: bump `@typescript-eslint/utils`, `@typescript-eslint/parser`, `@typescript-eslint/rule-tester` (`packages/eslint-plugin`) and root `typescript-eslint` to `8.68.0`; delete the `@typescript-eslint/utils` override from root `package.json`.
5. `bun install` to refresh `bun.lock` against the above (single lockfile-affecting step covering both the TS bump and the typescript-eslint bump together, since they're interdependent — a partial lockfile refresh risks resolving them out of sync).
6. Run, in this order, and fix forward on any red before proceeding to the next: `bun run typecheck` (root `tsc -b`) -> `bunx tsc -b packages/engine` -> `bunx tsc -b apps/web` -> `bun run lint` (includes the eslint-plugin `tsup --dts` build + `eslint .` + `lint:meta`) -> `bun run test:node` -> `bun run test:web` -> `bun run test:plugin` -> `bun run test:rust`.
7. Manually pay closest attention to whatever `tsc -b apps/web` reports for BC-2 (`noUncheckedSideEffectImports`) — this is the one genuinely behavioral item, everything else in this plan is mechanical or already a non-issue.
8. Do not touch Dependabot PR #418 (per instructions) — once this PR merges, Dependabot will likely re-diff its own PR against the new `6.0.3` base; leave that to happen naturally.

## Verification

- `bun run typecheck`, `bunx tsc -b packages/engine`, `bunx tsc -b apps/web` all clean.
- `bun run lint` clean (eslint-plugin build + `eslint .` + `lint:meta`).
- `bun run test:node`, `bun run test:web` (both vitest projects, including the browser project — watch for the documented mid-run dep-optimize hang trap, `reference_web_coverage_ci_freeze`, though that's a Vite/Vitest-version issue, not expected to be triggered by this TS-only bump), `bun run test:plugin`, `bun run test:rust` all green.
- `bun run codegen:check` (manual, not CI-wired today) — run once by hand post-bump as a sanity check on `gen-settings-scope.ts`'s Compiler API usage, since this migration is exactly the kind of change that should re-touch it even though nothing currently gates it.
- `bun run audit` still exits clean (a `typescript`/`typescript-eslint` bump is not expected to introduce new advisories, but this repo's audit gate is presently sensitive per the sibling `docs/deps/2026-08-31-dependency-upgrade-plan.md` report — worth a quick re-check since it touches `bun.lock`).

## Rollback

Land as its own PR stacked on `deps/phase-1-safe-bumps` (PR #465). This is a dev-tooling-only change set (typescript + typescript-eslint devDependencies, one tsconfig line, `bun.lock`) with zero production runtime code touched — rollback is a plain `git revert` of the merge commit, no data/state/migration concerns, no feature flags needed. If `bunx tsc -b apps/web` surfaces a large, unexpected `noUncheckedSideEffectImports` blast radius, the fallback is to set `"noUncheckedSideEffectImports": false` explicitly in the affected tsconfig(s) as a scoped opt-out rather than aborting the whole bump — that flag is independently toggleable and doesn't require reverting the TypeScript version itself.

## Out of Scope

- **TypeScript 7.0.2 (Dependabot PR #418 as filed).** Explicitly deferred — see Summary. Revisit only after both (a) TypeScript 7.1 ships stable with a restored programmatic API (not yet, only dev prereleases as of 2026-08-31), and (b) typescript-eslint ships an explicit release supporting it (currently closed not-planned on issue #12518 — watch that issue, not a date). This is a "don't do this yet" outcome for the 7.x jump specifically, not for the TypeScript package in general.
- Wiring `codegen:settings-scope --check` into CI/`lint:meta` — a real, independently-worthwhile gap noted above, but orthogonal to this version bump.
- The `@eslint/js` `^9.0.0` -> `^10.0.0` alignment — pre-existing, unrelated Phase-4 backlog item; confirmed no interaction with this migration.
- Any other Phase 2/3 items from `docs/deps/2026-08-31-dependency-upgrade-plan.md` (dompurify, tauri-plugin-updater, shiki, vitest 4, vite 8, storybook 10, marked, motion, claude-agent-sdk, codex-sdk) — separate migrations, not touched here.
