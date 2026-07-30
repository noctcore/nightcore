#!/usr/bin/env bun
/**
 * Cross-platform Rust CI gate — mirrors `.github/workflows/ci.yml` rust-checks:
 *   cargo fmt --check → test:rust → clippy → ts-rs drift diff.
 *
 * Every cargo invocation runs with cwd = the crate dir, NOT the repo root with
 * `--manifest-path`. Cargo discovers `.cargo/config.toml` by walking up from the
 * CURRENT WORKING DIRECTORY, not from the manifest path, so a root-cwd run reads
 * none of `apps/desktop/src-tauri/.cargo/config.toml` — `TS_RS_EXPORT_DIR` and
 * `TS_RS_LARGE_INT` stay unset, ts-rs dumps its bindings into the gitignored
 * crate-default `src-tauri/bindings/` (as `bigint`), and the `git diff` guard at
 * the bottom of this file then passes VACUOUSLY because nothing was written to
 * the directory it guards (#422). Running from the crate dir makes local and CI
 * read the same cargo config. `bindings::export`'s tests fail loudly if the env
 * ever goes missing again, and `bun run verify:drift-guard` proves the diff guard
 * still trips on a real `#[derive(TS)]` change.
 *
 * On Windows, `cargo fmt --check` fails when core.autocrlf rewrites the
 * working tree to CRLF while rustfmt.toml pins `newline_style = "Unix"`. CI
 * runs on Linux with LF checkouts, so fmt is skipped locally on win32; the
 * remaining steps still run here.
 */
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const CRATE = path.join(ROOT, 'apps', 'desktop', 'src-tauri');

function run(cmd: string): void {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

/** Runs cargo from the crate dir so `.cargo/config.toml` applies (see § above). */
function cargo(cmd: string): void {
  execSync(cmd, { cwd: CRATE, stdio: 'inherit' });
}

if (platform() !== 'win32') {
  cargo('cargo fmt --check');
  cargo(
    'cargo clippy --all-targets -- -D warnings -W clippy::await_holding_lock -W clippy::unwrap_used',
  );
  run('bun run test:rust');
} else {
  process.stderr.write(
    'check-rust: skipping cargo fmt --check and clippy on Windows (CRLF checkout + cfg-gated test imports differ from Linux CI); CI enforces both on ubuntu-latest\n',
  );
  // Single-threaded: parallel git-worktree integration tests flake on win32
  // when invoked from Husky while the parent repo is mid-commit.
  run('bun run --filter @nightcore/sidecar compile');
  cargo('cargo test -- --test-threads=1');
}

run('git diff --exit-code -- apps/web/src/lib/generated');
