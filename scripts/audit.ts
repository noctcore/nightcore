#!/usr/bin/env bun
/**
 * `bun run audit` — the JS-workspace dependency gate, and the single place the
 * `--audit-level` threshold and the ignore list are defined (CI runs this exact
 * script, so a local run reproduces the gate byte for byte).
 *
 * It enforces two things: the advisory threshold (below), and that every
 * dependency override carries an upper bound (`assertOverridesBounded`).
 *
 * ## The threshold
 *
 * `moderate`. Nightcore renders model/PR/web content through marked + dompurify +
 * shiki, so a moderate advisory in the sanitizer/markdown stack is exactly the class
 * this gate must catch. Per `.github/workflows/audit.yml`, a specific advisory that
 * needs tolerating is ignored BY ID here — never by raising the global threshold.
 *
 * ## The ignore list
 *
 * Every entry needs a reason that survives review, and every entry is load-bearing:
 * an id that no longer appears in the audit output FAILS this script rather than
 * lingering. Suppression is a standing claim about reachability; when upstream ships
 * a fix, the claim expires and the entry must go.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

interface Ignored {
  /** GHSA id, as it appears in the advisory URL. */
  readonly id: string;
  /** Package the advisory is filed against. */
  readonly pkg: string;
  readonly severity: 'moderate' | 'high';
  /** Why this is not reachable in this app — the claim being made. */
  readonly rationale: string;
  /** What would let us drop this entry. */
  readonly exit: string;
}

/**
 * Advisories tolerated with cause. Empty as of the 2026-08-31 dependency
 * refresh (docs/deps/2026-08-31-dependency-upgrade-plan.md, Phase 1): the
 * brace-expansion and hono/@hono-node-server entries that used to live here
 * all cleared via a lockfile refresh (see git history for the prior list).
 */
const IGNORED: readonly Ignored[] = [] as const;

const AUDIT_LEVEL = 'moderate';

/**
 * ## The override bound rule
 *
 * **An override forces a PATCHED version. It never crosses a major.**
 *
 * An override rewrites what EVERY consumer in the tree resolves to, including
 * consumers whose own declared range forbids it. Written without an upper bound
 * it silently authorises a major nobody reviewed — and because overrides only
 * bite once something actually pulls the package in, the break lands on whoever
 * next adds an unrelated dependency, with a failure that points nowhere near the
 * override. Three occurrences of exactly that:
 *
 * - `brace-expansion >=2.1.2` (#411) — forced 2.x on 1.x consumers under vite;
 *   `brace_expansion_1.expand is not a function` on every module transform.
 *   Reverted in the same PR.
 * - `js-yaml >=4.3.0` (#411) — resolved to 5.2.2, which drops the default export
 *   Astro imports. Dormant until #434 added the docs site, then broke its build.
 * - `fast-uri >=3.1.4` (#411) — resolved to 4.1.1 while its only consumer, ajv 8,
 *   declares `^3.0.1`. Found and bounded in #435 before it detonated.
 *
 * #411 *stated* this rule in its commit message ("without ... crossing a major
 * boundary") and the ranges still did not express it, which is why this is a
 * check and not a comment. The fix is always the same: bound the entry to the
 * major its consumers already declare (`>=x.y.z <MAJOR+1`). If the patched
 * version exists ONLY across a major, that is a dependency bump to review on its
 * own merits — not something to smuggle in through the override map.
 */
function assertOverridesBounded(): void {
  const manifestUrl = new URL('../package.json', import.meta.url);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    // Loud on purpose. A check that cannot find what it checks must fail, not pass:
    // a moved/renamed root manifest would otherwise retire this gate in silence.
    throw new Error(
      `audit: cannot read the root package.json at ${manifestUrl.pathname} — ` +
        `the override-bound check cannot run.\n${String(err)}`,
    );
  }
  // Same tripwire: only the ROOT manifest declares workspaces, so this pins the
  // check to the file that actually holds the override map.
  if (!Array.isArray(manifest.workspaces)) {
    throw new Error(
      'audit: the manifest read for the override-bound check declares no "workspaces" ' +
        'array, so it is not the root package.json. Fix the path in scripts/audit.ts.',
    );
  }

  /**
   * A range is unbounded when it opens a lower bound and never closes an upper
   * one. `^8.5.6`, `~3.1.4` and exact pins are inherently bounded; `>=8.5.18` is
   * not. Checked per OR-clause so `>=1 <2 || >=3` is caught on its second clause.
   */
  const isUnbounded = (range: string): boolean =>
    range
      .split('||')
      .some((clause) => /(?:^|\s)>=?/.test(clause) && !/(?:^|\s)<=?/.test(clause));

  const unbounded: string[] = [];
  // Bun honours BOTH keys, so checking only `overrides` would let a rename walk
  // straight past this gate.
  const collect = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (isUnbounded(node)) unbounded.push(`${path}: "${node}"`);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('//')) continue; // `//` keys are comments, not packages.
      collect(value, path === '' ? key : `${path} > ${key}`);
    }
  };
  for (const field of ['overrides', 'resolutions'] as const) {
    // Absent is fine — no overrides is the state this rule is pushing toward.
    if (manifest[field] !== undefined) collect(manifest[field], '');
  }

  if (unbounded.length > 0) {
    process.stderr.write(
      '\n✗ audit: dependency override(s) with no upper bound.\n\n' +
        'An override forces a PATCHED version, it never crosses a major — an\n' +
        'unbounded range authorises a major nobody reviewed, and it breaks for\n' +
        'whoever next adds an unrelated dependency (see scripts/audit.ts for the\n' +
        'three times this has already happened). Bound each to the major its\n' +
        'consumers declare, e.g. ">=8.5.18 <9":\n\n' +
        unbounded.map((e) => `  - ${e}`).join('\n') +
        '\n\n',
    );
    process.exit(1);
  }
}

assertOverridesBounded();

/** Every GHSA id currently reported, at any severity. */
function reportedAdvisoryIds(): Set<string> {
  let raw: string;
  try {
    raw = execFileSync('bun', ['audit', '--json'], { encoding: 'utf8' });
  } catch (err) {
    // `bun audit` exits non-zero WHEN VULNERABILITIES EXIST, which is the normal
    // case here — the payload still lands on stdout.
    const out = (err as { stdout?: string }).stdout;
    if (!out) throw err;
    raw = out;
  }
  const byPackage = JSON.parse(raw) as Record<
    string,
    ReadonlyArray<{ url?: string }>
  >;
  const ids = new Set<string>();
  for (const advisories of Object.values(byPackage)) {
    for (const a of advisories) {
      const id = a.url?.split('/').pop();
      if (id) ids.add(id);
    }
  }
  return ids;
}

const reported = reportedAdvisoryIds();
const stale = IGNORED.filter((entry) => !reported.has(entry.id));

if (stale.length > 0) {
  process.stderr.write(
    '\n✗ audit: the ignore list has entries that no longer match any advisory.\n' +
      'Upstream has most likely shipped a fix — remove these from scripts/audit.ts\n' +
      'so the gate stops suppressing something it no longer needs to:\n\n' +
      stale.map((e) => `  - ${e.id} (${e.pkg})`).join('\n') +
      '\n\n',
  );
  process.exit(1);
}

if (IGNORED.length > 0) {
  process.stdout.write(
    `audit: tolerating ${IGNORED.length} advisor${IGNORED.length === 1 ? 'y' : 'ies'} with cause ` +
      `(see scripts/audit.ts):\n` +
      IGNORED.map((e) => `  · ${e.id} ${e.pkg} [${e.severity}]`).join('\n') +
      '\n\n',
  );
}

// The gate itself. Anything at or above the threshold that is NOT on the list above
// fails the build.
execFileSync(
  'bun',
  [
    'audit',
    `--audit-level=${AUDIT_LEVEL}`,
    ...IGNORED.map((e) => `--ignore=${e.id}`),
  ],
  { stdio: 'inherit' },
);
