#!/usr/bin/env bun
/**
 * `codegen:check` — ONE command that verifies every generated / cross-tier contract
 * artifact is in sync (issue #158, T17 contract debt). Today the drift gates are scattered
 * across `lint` (zod→Rust), `test:node` (TS canaries), and `check:rust` (Rust→web ts-rs +
 * parity) — so a contributor who touches a contract has no single "is my codegen coherent?"
 * command. This aggregates them, fast TS-side leg first so the cheap checks fail before the
 * Rust toolchain spins up.
 *
 * The legs, in order:
 *   1. zod → Rust contracts — `gen-rust-contracts.ts --check` regenerates `generated.rs` +
 *      `fixtures.json` in memory and diffs (the same gate lint-meta's `codegen-drift` runs).
 *   2. engine → web capabilities — `gen-web-capabilities.ts --check` diffs the web's
 *      synchronous Claude default against the engine descriptor it is generated from
 *      (issue #158). Cheap and TS-side, so it sits beside leg 1.
 *   3. Rust override shape → web settings-scope map — `gen-settings-scope.ts --check`
 *      diffs the per-project-overridable field set the Settings surface derives its scope
 *      badges from against the `SettingsOverride` ts-rs binding (issue #404). Also cheap
 *      and TS-side. It reads the binding the LAST leg regenerates, which is fine: a stale
 *      binding fails that leg's diff regardless.
 *   4. TS codegen canaries + cross-boundary conformance — the `tools/codegen` unit tests
 *      (ENUM_NAMES injectivity, number-type drift, channel determinism) and
 *      `codegen-conformance.test.ts` (ts-rs ⇄ zod field-set + round-trip).
 *   5. Rust → web ts-rs bindings + contract parity — `cargo test` regenerates the ts-rs
 *      bindings under `apps/web/src/lib/generated` as a side effect and runs the contract
 *      round-trip / variant-parity tests; a `git diff --exit-code` then fails on any
 *      un-committed binding drift. Scoped to the `bindings` + `contracts` tests (NOT full
 *      `check:rust`) so this stays a codegen gate, not a clippy/fmt pass.
 *
 * Any leg failing exits non-zero. Run after changing anything in `packages/contracts`,
 * `tools/codegen`, or a ts-rs-exported Rust type.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const CRATE = path.join(ROOT, 'apps', 'desktop', 'src-tauri');
const GENERATED_WEB = 'apps/web/src/lib/generated';

function step(label: string, cmd: string, cwd = ROOT): void {
  process.stdout.write(`\n▶ codegen:check — ${label}\n`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

/**
 * Cargo legs run from the CRATE dir, never `--manifest-path` from the root: cargo
 * discovers `.cargo/config.toml` by walking up from the working directory, and that
 * file is what points ts-rs at `apps/web/src/lib/generated` (`TS_RS_EXPORT_DIR`) with
 * `TS_RS_LARGE_INT=number`. Run from the root, the regen leg wrote `bigint` bindings
 * into the gitignored crate-default `bindings/` and the diff leg below then passed
 * VACUOUSLY — nothing had been written to the directory it diffs (#422).
 */
function cargoStep(label: string, cmd: string): void {
  step(label, cmd, CRATE);
}

// 1. zod → Rust: generated.rs + fixtures.json.
step('zod → Rust contracts drift', 'bun run codegen:contracts --check');

// 2. engine → web Claude capability default.
step(
  'engine → web capabilities drift',
  'bun run codegen:capabilities --check',
);

// 3. Rust override shape → web settings-scope map. Reads the ts-rs binding the last leg
//    regenerates, so a stale binding is caught by that leg's diff either way; running it
//    here keeps the cheap TS-side legs together.
step(
  'settings-scope map drift',
  'bun run codegen:settings-scope --check',
);

// 4. TS codegen canaries + cross-boundary conformance.
step(
  'TS codegen canaries + conformance',
  'bun test tools/codegen packages/contracts/src/codegen-conformance.test.ts',
);

// 5. Rust → web ts-rs bindings + contract parity. `cargo test` takes a single test-name
//    filter, so the two codegen-relevant groups run as separate scoped passes (the crate is
//    compiled once and cached). The `bindings` pass regenerates the web bindings on disk; the
//    `contracts` pass runs the round-trip / variant-parity guards; the git diff then fails on
//    any binding that was not re-committed. Scoped (NOT full `check:rust`) so this stays a
//    codegen gate, not a clippy/fmt pass.
cargoStep('Rust ts-rs binding regen', 'cargo test --lib bindings');
cargoStep('Rust contract parity + round-trip', 'cargo test --lib contracts');
step(
  'Rust → web ts-rs bindings drift',
  `git diff --exit-code -- ${GENERATED_WEB}`,
);

process.stdout.write('\n✓ codegen:check — all generated artifacts in sync\n');
