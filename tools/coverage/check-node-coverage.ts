/**
 * Coverage floor for the `test:node` suite (apps/sidecar + packages/* +
 * tools/codegen). Runs the suite under Bun's coverage collector, prints the
 * per-file table for per-PR visibility, then enforces a modest line/function
 * floor on real source — excluding node_modules and the built /dist/ duplicates
 * that Bun instruments when a package is imported through its compiled barrel.
 *
 * Why a script and not bunfig `coverageThreshold`: Bun 1.3.x reads that key but
 * does not fail the run on it, so the floor would be silently unenforced. The
 * floor is deliberately conservative (well under today's ~89% line / ~85%
 * function on src) — a safety net against a new module or public method shipping
 * with zero tests, not a ceiling. Tighten it over time, ratchet-style
 * (cf. apps/desktop/src-tauri/src/workflow/ratchet.rs for the Rust-side pattern).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dir, '..', '..');

// Mirrors the `test:node` path list in package.json.
const SUITE = [
  'apps/sidecar',
  'packages/config',
  'packages/contracts',
  'packages/engine',
  'packages/harness',
  'packages/session-fold',
  'packages/shared',
  'packages/storage',
  'tools/codegen',
];

// Global aggregate floor, ratcheted toward the real ~90% line / ~87% function
// coverage (a small margin below actual, not a ceiling). Re-tighten periodically.
const FLOOR = { lines: 0.87, functions: 0.83 };

// Per-file line floor: an aggregate alone lets a large untested module hide in
// the average (a 0%-covered 400-line file barely moves a 90% suite). This guard
// fails if any SUBSTANTIAL source file (>= MIN_FILE_LINES instrumented lines)
// dips below PER_FILE_FLOOR, so a whole untested module can't land green. Kept
// well below the current per-file minimum (~60%) so it's a safety net, not a
// ceiling; tiny files are exempt to avoid noise from a couple of uncovered lines.
const PER_FILE_FLOOR = 0.5;
const MIN_FILE_LINES = 25;

const covDir = mkdtempSync(path.join(tmpdir(), 'nc-node-cov-'));

const run = spawnSync(
  'bun',
  [
    'test',
    ...SUITE,
    '--coverage',
    '--coverage-reporter=text',
    '--coverage-reporter=lcov',
    `--coverage-dir=${covDir}`,
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

// A failing/errored test run is surfaced as-is; coverage is moot until it passes.
if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

const lcov = readFileSync(path.join(covDir, 'lcov.info'), 'utf8');

let linesFound = 0;
let linesHit = 0;
let fnFound = 0;
let fnHit = 0;
let include = true;

// Per-file line accounting for the per-file floor guard.
let curFile = '';
let curLF = 0;
let curLH = 0;
const underFloor: string[] = [];

const flushFile = () => {
  if (include && curFile !== '' && curLF >= MIN_FILE_LINES) {
    const ratio = curLH / curLF;
    if (ratio < PER_FILE_FLOOR) {
      underFloor.push(`${pctOf(ratio)} ${path.relative(ROOT, curFile)} (${curLH}/${curLF} lines)`);
    }
  }
  curFile = '';
  curLF = 0;
  curLH = 0;
};

const pctOf = (n: number) => `${(n * 100).toFixed(2)}%`;

for (const raw of lcov.split('\n')) {
  if (raw.startsWith('SF:')) {
    flushFile();
    const file = raw.slice(3);
    include = !file.includes('node_modules') && !file.includes('/dist/');
    curFile = file;
    continue;
  }
  if (raw === 'end_of_record') {
    flushFile();
    continue;
  }
  if (!include) continue;
  if (raw.startsWith('LF:')) {
    const n = Number(raw.slice(3));
    linesFound += n;
    curLF += n;
  } else if (raw.startsWith('LH:')) {
    const n = Number(raw.slice(3));
    linesHit += n;
    curLH += n;
  } else if (raw.startsWith('FNF:')) fnFound += Number(raw.slice(4));
  else if (raw.startsWith('FNH:')) fnHit += Number(raw.slice(4));
}
flushFile();

const lines = linesFound === 0 ? 1 : linesHit / linesFound;
const functions = fnFound === 0 ? 1 : fnHit / fnFound;

const pct = pctOf;

const failures: string[] = [];
if (lines < FLOOR.lines) failures.push(`lines ${pct(lines)} < floor ${pct(FLOOR.lines)}`);
if (functions < FLOOR.functions) {
  failures.push(`functions ${pct(functions)} < floor ${pct(FLOOR.functions)}`);
}
if (underFloor.length > 0) {
  failures.push(
    `${underFloor.length} file(s) below the ${pct(PER_FILE_FLOOR)} per-file floor: ${underFloor.join(', ')}`,
  );
}

console.log(
  `\nnode coverage (src, excl. dist): lines ${pct(lines)} (floor ${pct(FLOOR.lines)}), ` +
    `functions ${pct(functions)} (floor ${pct(FLOOR.functions)}); ` +
    `per-file line floor ${pct(PER_FILE_FLOOR)} (files ≥ ${MIN_FILE_LINES} lines)`,
);

if (failures.length > 0) {
  console.error(`✖ node coverage floor not met: ${failures.join('; ')}`);
  process.exit(1);
}

console.log('✔ node coverage floor met');
