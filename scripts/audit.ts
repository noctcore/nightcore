#!/usr/bin/env bun
/**
 * `bun run audit` — the JS-workspace dependency gate, and the single place the
 * `--audit-level` threshold and the ignore list are defined (CI runs this exact
 * script, so a local run reproduces the gate byte for byte).
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
 * Advisories tolerated with cause. All are transitive and none is fixable by a
 * version bump today (verified 2026-07-25, issue #158 branch).
 */
const IGNORED: readonly Ignored[] = [
  {
    id: 'GHSA-mh99-v99m-4gvg',
    pkg: 'brace-expansion',
    severity: 'high',
    rationale:
      'Build-time tooling only (minimatch under typescript-eslint / storybook / ' +
      '@vitest/coverage-istanbul / vite). The DoS needs an attacker-supplied glob; ' +
      'every pattern here is authored in this repo. No runtime/product exposure.',
    exit:
      'Advisory covers <=5.0.7, i.e. EVERY published version including the 1.x line ' +
      'our consumers require — there is no version to move to. Drop this entry once ' +
      'a fixed release exists and the consumers accept it. Note: forcing 2.x on the ' +
      '1.x consumers breaks them outright (`brace_expansion_1.expand is not a ' +
      'function`) — tried and reverted on this branch.',
  },
  {
    id: 'GHSA-frvp-7c67-39w9',
    pkg: '@hono/node-server',
    severity: 'moderate',
    rationale:
      'Path traversal in `serve-static` on Windows. Reached only through the Claude ' +
      'Agent SDK’s internal transport; Nightcore never mounts hono static file serving.',
    exit: 'Drop when the pinned @anthropic-ai/claude-agent-sdk ships a bumped @hono/node-server.',
  },
  {
    id: 'GHSA-xgm2-5f3f-mvvc',
    pkg: 'hono',
    severity: 'moderate',
    rationale:
      'AWS API Gateway v1 adapter drops a repeated request header. Nightcore is a ' +
      'local-first desktop app — there is no API Gateway deployment.',
    exit: 'Drop when the pinned @anthropic-ai/claude-agent-sdk ships hono >=4.12.27.',
  },
  {
    id: 'GHSA-hvrm-45r6-mjfj',
    pkg: 'hono',
    severity: 'moderate',
    rationale:
      '`hono/jsx` does not isolate context per request. Nothing in this repo imports ' +
      'hono/jsx; the SDK uses hono as a plain local transport.',
    exit: 'Drop when the pinned @anthropic-ai/claude-agent-sdk ships hono >=4.12.27.',
  },
  {
    id: 'GHSA-w62v-xxxg-mg59',
    pkg: 'hono',
    severity: 'moderate',
    rationale:
      'Server-side XSS via the `cx()` JSX utility. Same as above — no hono JSX ' +
      'rendering anywhere in this codebase.',
    exit: 'Drop when the pinned @anthropic-ai/claude-agent-sdk ships hono >=4.12.27.',
  },
] as const;

const AUDIT_LEVEL = 'moderate';

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
