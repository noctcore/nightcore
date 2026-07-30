#!/usr/bin/env bun
/**
 * Coverage floor for the Rust core (`apps/desktop/src-tauri`) — the tier-parity
 * sibling of `check-node-coverage.ts` (node) and `apps/web/vitest.config.ts`'s
 * istanbul thresholds (web). Rust was the ONLY tier without a floor, and it is the
 * tier that holds the confinement (Seatbelt / path-confine), git-isolation and
 * store-atomicity code — where an untested regression is a containment regression
 * (issue #407).
 *
 * Runs the same suite `cargo test` runs, under `cargo-llvm-cov` (source-based
 * LLVM instrumentation), prints the totals plus the worst-covered substantial
 * files for per-PR visibility, then fails below the floor.
 *
 * Why a wrapper and not a bare `cargo llvm-cov --fail-under-lines N` in the
 * workflow: (a) cargo MUST run with cwd = the crate dir or `.cargo/config.toml`
 * is not read and the ts-rs export test dumps its bindings into the gitignored
 * crate-default `bindings/` (#422) — this script owns that invariant; (b) the
 * floor constants and their rationale live in code next to the node tier's, not
 * buried in YAML; (c) the per-file debt table has nowhere else to live.
 *
 * Ratchet, not a ceiling: the floor starts just below the measured current
 * coverage and may only ever be RAISED. If a change legitimately lowers it, cover
 * the new code instead — the same rule as `check-node-coverage.ts` and
 * `workflow/ratchet.rs`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const CRATE = path.join(ROOT, 'apps', 'desktop', 'src-tauri');

/**
 * Aggregate floor over the whole crate.
 *
 * Measured when this floor was introduced (1479 tests, 251 files):
 *   - ubuntu (where the gate runs):  **72.73% lines / 65.58% functions**
 *   - macOS aarch64:                   72.91% lines / 65.71% functions
 * They differ only slightly, but they DO differ: `#[cfg(target_os = ...)]` code
 * instruments only on the platform that compiles it. The floor is pinned just under
 * the LINUX numbers with a fraction of a point of slack; every run prints the exact
 * figure, so tighten it straight from a job log.
 *
 * The percentages include the crate's inline `#[cfg(test)]` bodies — llvm-cov
 * instruments test code too, and this crate's convention is inline tests (~37% of
 * its lines). So treat these as a RELATIVE ratchet against untested code landing,
 * not as an absolute "production lines covered" figure.
 */
const FLOOR = { lines: 72, functions: 65 };

/** How many of the worst-covered substantial files to print as debt visibility. */
const DEBT_ROWS = 12;
const DEBT_MIN_LINES = 100;

const outDir = mkdtempSync(path.join(tmpdir(), 'nc-rust-cov-'));
const jsonPath = path.join(outDir, 'coverage.json');

// cwd = CRATE so rust-toolchain.toml AND .cargo/config.toml both apply (#422).
// `--no-fail-fast` reports coverage for the whole suite even if one test fails;
// cargo still exits non-zero, which we surface as-is.
const run = spawnSync(
  'cargo',
  ['llvm-cov', '--no-fail-fast', '--json', '--output-path', jsonPath],
  { cwd: CRATE, stdio: 'inherit' },
);

if (run.error) throw run.error;
// A failing/errored test run is surfaced as-is; coverage is moot until it passes.
if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

type Summary = {
  lines: { count: number; covered: number; percent: number };
  functions: { count: number; covered: number; percent: number };
};
type Export = {
  data: [{ totals: Summary; files: { filename: string; summary: Summary }[] }];
};

const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as Export;
const { totals, files } = report.data[0];

const pct = (n: number) => `${n.toFixed(2)}%`;

const debt = files
  .filter((f) => f.summary.lines.count >= DEBT_MIN_LINES)
  .sort((a, b) => a.summary.lines.percent - b.summary.lines.percent)
  .slice(0, DEBT_ROWS);

console.log(`\nlowest-covered files ≥ ${DEBT_MIN_LINES} instrumented lines (coverage debt):`);
for (const f of debt) {
  const rel = path.relative(CRATE, f.filename);
  const s = f.summary.lines;
  console.log(`  ${pct(s.percent).padStart(7)}  ${String(s.count).padStart(5)} lines  ${rel}`);
}

console.log(
  `\nrust coverage (${files.length} files): lines ${pct(totals.lines.percent)} ` +
    `(${totals.lines.covered}/${totals.lines.count}, floor ${pct(FLOOR.lines)}), ` +
    `functions ${pct(totals.functions.percent)} ` +
    `(${totals.functions.covered}/${totals.functions.count}, floor ${pct(FLOOR.functions)})`,
);

const failures: string[] = [];
if (totals.lines.percent < FLOOR.lines) {
  failures.push(`lines ${pct(totals.lines.percent)} < floor ${pct(FLOOR.lines)}`);
}
if (totals.functions.percent < FLOOR.functions) {
  failures.push(`functions ${pct(totals.functions.percent)} < floor ${pct(FLOOR.functions)}`);
}

if (failures.length > 0) {
  console.error(
    `✖ rust coverage floor not met: ${failures.join('; ')} — cover the new code; ` +
      `the floor is a ratchet and only ever goes UP`,
  );
  process.exit(1);
}

console.log('✔ rust coverage floor met');
