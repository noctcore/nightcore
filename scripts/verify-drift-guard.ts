#!/usr/bin/env bun
/**
 * Guard-integrity check for the ts-rs regenerate-and-diff gate (#422).
 *
 * The gate is two steps: `cargo test` re-exports every `#[derive(TS)]` boundary
 * type into `apps/web/src/lib/generated/`, then `git diff --exit-code` over that
 * directory fails if the committed bindings no longer match the Rust structs.
 * That gate spent its whole life passing VACUOUSLY from both local entry points:
 * cargo reads `.cargo/config.toml` by walking up from the CWD (not from
 * `--manifest-path`), so a root-cwd run left `TS_RS_EXPORT_DIR` unset, ts-rs wrote
 * to the gitignored crate-default `src-tauri/bindings/`, and the diff was clean
 * because NOTHING was written to the guarded directory. A guard that silently
 * became a no-op once will do it again, so this script proves it is still real:
 *
 *   1. perturb a `#[derive(TS)]` type (a doc comment — ts-rs 12 emits it as JSDoc,
 *      so the generated `.ts` changes while Rust semantics/compilation do not),
 *   2. re-run the export exactly the way the gate does (cwd = crate dir),
 *   3. assert `git diff --exit-code -- apps/web/src/lib/generated` now FAILS and
 *      that the diff carries the probe marker,
 *   4. restore the source and the bindings, and assert both are clean again.
 *
 * If step 3 sees a clean diff, the drift guard is a no-op again and this exits 1.
 *
 * Run: `bun run verify:drift-guard` (CI runs it in the `rust-checks` job, after
 * `test:rust` has compiled the sidecar externalBin and warmed the cargo cache).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dir, '..');
const CRATE = path.join(ROOT, 'apps', 'desktop', 'src-tauri');
/** The directory the real gate guards, repo-relative (as git pathspecs want it). */
const GENERATED = 'apps/web/src/lib/generated';
/** Repo-relative path of the type we perturb, and the binding it must rewrite. */
const TARGET = 'apps/desktop/src-tauri/src/terminal/title.rs';
const TARGET_ANCHOR = 'pub enum TitleSource {';
const TARGET_BINDING = `${GENERATED}/TitleSource.ts`;
const MARKER = 'nightcore-drift-guard-probe: this line must never be committed';

function git(args: string[]): { status: number; stdout: string } {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

function fail(message: string): never {
  console.error(`✖ drift-guard verification: ${message}`);
  process.exit(1);
}

// ── Pre-flight ──────────────────────────────────────────────────────────────
// This script writes to tracked files and restores them from HEAD, so it refuses
// to run over uncommitted work in those paths — otherwise the restore would
// silently discard someone's edits.
const dirty = git(['status', '--porcelain', '--', GENERATED, TARGET]).stdout.trim();
if (dirty !== '') {
  fail(
    `uncommitted changes under ${GENERATED} or ${TARGET} — commit or stash them first ` +
      `(this check mutates and restores those paths):\n${dirty}`,
  );
}

// The diff half of the gate is only meaningful if the bindings are TRACKED. An
// entry in .gitignore (or an unstaged-but-untracked tree) would make
// `git diff --exit-code` permanently clean — the same vacuity by another route.
if (git(['check-ignore', '-q', '--', GENERATED]).status === 0) {
  fail(`${GENERATED} is git-ignored — \`git diff --exit-code\` over it can never fail`);
}
const tracked = git(['ls-files', '--', GENERATED]).stdout.trim().split('\n').filter(Boolean);
if (tracked.length === 0) fail(`no tracked files under ${GENERATED} — nothing for the gate to diff`);
if (!tracked.includes(TARGET_BINDING)) {
  fail(`${TARGET_BINDING} is not tracked — pick a different probe type`);
}

// ── 1. Perturb the `#[derive(TS)]` type ─────────────────────────────────────
const targetAbs = path.join(ROOT, TARGET);
const original = readFileSync(targetAbs, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.split(eol);
const anchor = lines.findIndex((l) => l.trim().startsWith(TARGET_ANCHOR));
if (anchor === -1) {
  fail(
    `anchor \`${TARGET_ANCHOR}\` not found in ${TARGET} — the probe type was renamed or moved; ` +
      `point this script at another \`#[derive(TS)]\` type`,
  );
}
// Walk back over the item's attribute + doc-comment block so the marker lands at
// the TOP of the doc comment (a doc comment is a legal attribute anywhere in that
// block, and ts-rs emits the whole block as one JSDoc).
let insertAt = anchor;
while (insertAt > 0) {
  const prev = lines[insertAt - 1]?.trim() ?? '';
  if (prev.startsWith('///') || prev.startsWith('#[')) insertAt -= 1;
  else break;
}
lines.splice(insertAt, 0, `/// ${MARKER}`);
writeFileSync(targetAbs, lines.join(eol));

let verdict: string | null = null;
try {
  // ── 2. Re-export the bindings the way the gate does ───────────────────────
  // cwd = CRATE so `.cargo/config.toml` (TS_RS_EXPORT_DIR / TS_RS_LARGE_INT)
  // applies — the whole point of #422. Scoped to the export aggregator's test so
  // this costs one incremental lib rebuild, not the full suite.
  console.log(`drift-guard: perturbed ${TARGET}; re-running the ts-rs export…`);
  const cargo = spawnSync('cargo', ['test', '--lib', 'bindings::export'], {
    cwd: CRATE,
    stdio: 'inherit',
  });
  if (cargo.status !== 0) {
    verdict = `the scoped export run (\`cargo test --lib bindings::export\`, cwd ${CRATE}) failed — cannot judge the guard`;
  } else {
    // ── 3. The guard must now trip ──────────────────────────────────────────
    const diff = git(['diff', '--exit-code', '--', GENERATED]);
    if (diff.status === 0) {
      verdict =
        `the guard did NOT trip. \`cargo test\` ran with a changed \`#[derive(TS)]\` type and ` +
        `\`git diff --exit-code -- ${GENERATED}\` still reported clean, so the ts-rs drift gate is a ` +
        `no-op: the export is not landing in the guarded directory (is cargo running from ${CRATE}, ` +
        `so .cargo/config.toml sets TS_RS_EXPORT_DIR?). See #422.`;
    } else if (!diff.stdout.includes(MARKER)) {
      verdict =
        `the guard tripped, but the diff does not contain the probe marker — the change it caught is ` +
        `not the one this script made:\n${diff.stdout.slice(0, 2000)}`;
    } else if (!diff.stdout.includes('TitleSource.ts')) {
      verdict = `the diff carries the marker but not in TitleSource.ts:\n${diff.stdout.slice(0, 2000)}`;
    }
  }
} finally {
  // ── 4. Restore ────────────────────────────────────────────────────────────
  // Source first (bytes we read, never `git checkout` — cheaper and exact), then
  // the regenerated bindings from HEAD. The pre-flight proved these paths were
  // clean, so discarding everything the run produced here is safe.
  writeFileSync(targetAbs, original);
  git(['checkout', '--', GENERATED]);
  git(['clean', '-fdq', '--', GENERATED]);
  const leftover = git(['status', '--porcelain', '--', GENERATED, TARGET]).stdout.trim();
  if (leftover !== '') {
    console.error(
      `✖ drift-guard verification: FAILED TO RESTORE — reset these paths by hand:\n${leftover}`,
    );
    process.exit(1);
  }
}

if (verdict !== null) fail(verdict);

console.log(
  `✔ ts-rs drift guard is real: a doc-comment change to \`TitleSource\` regenerated ` +
    `${TARGET_BINDING} and \`git diff --exit-code -- ${GENERATED}\` failed as designed (source + bindings restored)`,
);
