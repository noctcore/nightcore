import { afterAll, describe, expect, test } from 'bun:test';

import {
  checkPnpmPatchLedger,
  createPnpmPatchLedgerRule,
  patchFileHash,
  readLockfilePatches,
  readPatchedDependencies,
} from './pnpm-patch-ledger.js';
import { createFixture, type IFixture, messages, removeFixtures, runSync } from './test-support.js';

afterAll(removeFixtures);

/*
 * A frozen "today" so the reviewBy cases mean the same thing next year. Every
 * date below is written relative to it.
 */
const TODAY = new Date('2026-10-13T00:00:00Z');
const FUTURE = '2026-12-01';
const PAST = '2026-10-12';

const KEY = '@scope/runner@10.0.0';
const PATCH_PATH = 'patches/@scope__runner@10.0.0.patch';
const PATCH = [
  'diff --git a/dist/a.js b/dist/a.js',
  '--- a/dist/a.js',
  '+++ b/dist/a.js',
  '@@ -1 +1 @@',
  '-old();',
  '+fixed();',
  '',
].join('\n');

const ENTRY = {
  reason: 'The runner matches no test name on the new test framework, so every mutant survives.',
  upstream: 'https://example.test/runner/issues/6210',
  removeWhen: 'A runner release joins test names the way the framework does.',
  reviewBy: FUTURE,
};

function workspace(patches: Record<string, string>): string {
  return [
    'packages:',
    "  - 'apps/*'",
    '',
    '# Why the runner is patched lives in patches.ledger.json.',
    'patchedDependencies:',
    ...Object.entries(patches).map(([key, path]) => `  '${key}': ${path}`),
    '',
    'onlyBuiltDependencies:',
    '  - esbuild',
    '',
  ].join('\n');
}

function lockfile(patches: Record<string, { hash: string; path: string }>): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'overrides:',
    '  tar@<7.5.21: ^7.5.21',
    '',
    'patchedDependencies:',
    ...Object.entries(patches).flatMap(([key, patch]) => [
      `  '${key}':`,
      `    hash: ${patch.hash}`,
      `    path: ${patch.path}`,
    ]),
    '',
    'importers:',
    '',
    '  .: {}',
    '',
  ].join('\n');
}

/** A fixture whose patch, ledger entry, patch file and lockfile all agree. */
function cleanFixture(): IFixture {
  return createFixture({
    'pnpm-workspace.yaml': workspace({ [KEY]: PATCH_PATH }),
    'patches.ledger.json': JSON.stringify({ [KEY]: ENTRY }, null, 2),
    [PATCH_PATH]: PATCH,
    'pnpm-lock.yaml': lockfile({ [KEY]: { hash: patchFileHash(PATCH), path: PATCH_PATH } }),
  });
}

function check(fixture: IFixture, today: Date = TODAY) {
  return checkPnpmPatchLedger(fixture.ctx(), today);
}

function only(fixture: IFixture): string {
  const violations = check(fixture);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.rule).toBe('pnpm-patch-ledger');
  return violations[0]?.message ?? '';
}

describe('pnpm-patch-ledger', () => {
  test('passes a patch whose ledger entry, patch file and lockfile all agree with it', () => {
    expect(check(cleanFixture())).toEqual([]);
  });

  test('stays dormant when the repo patches nothing and has no ledger', () => {
    expect(check(createFixture({ 'package.json': JSON.stringify({ name: 'fixture' }) }))).toEqual([]);
  });

  test('reports a patch with no ledger entry', () => {
    const fixture = cleanFixture();
    fixture.write({ 'patches.ledger.json': '{}' });

    expect(only(fixture)).toMatch(
      /`@scope\/runner@10\.0\.0` is patched with patches\/@scope__runner@10\.0\.0\.patch and has no ledger entry/u,
    );
  });

  test('reports a ledger entry with no patch, which is what a patch moved to another version leaves', () => {
    const fixture = cleanFixture();
    fixture.write({
      'patches.ledger.json': JSON.stringify({ [KEY]: ENTRY, '@scope/runner@9.6.1': ENTRY }),
    });

    expect(messages(check(fixture))).toEqual([
      '`@scope/runner@9.6.1` has a ledger entry but no matching `patchedDependencies` key. Delete the entry, or, if the patch moved to another version, write the entry for that version.',
    ]);
  });

  test('reports a patched dependency with no ledger file at all', () => {
    const fixture = createFixture({
      'pnpm-workspace.yaml': workspace({ [KEY]: PATCH_PATH }),
      [PATCH_PATH]: PATCH,
    });

    const violations = check(fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('patches.ledger.json');
    expect(violations[0]?.message ?? '').toMatch(/patches\.ledger\.json does not exist/u);
  });

  test('reports a ledger that is not an object keyed by patch', () => {
    const fixture = cleanFixture();
    fixture.write({ 'patches.ledger.json': '[]' });

    expect(only(fixture)).toMatch(/patches\.ledger\.json is not a JSON object/u);
  });

  test('reports an entry that is not an object, or has no reason, upstream link or removal condition', () => {
    const cases: readonly [unknown, RegExp][] = [
      ['a string', /the entry is not an object/u],
      [{ ...ENTRY, reason: '' }, /`reason` must be a non-empty string/u],
      [{ ...ENTRY, reason: undefined }, /`reason` must be a non-empty string/u],
      [{ ...ENTRY, upstream: undefined }, /`upstream` must be an https link/u],
      [{ ...ENTRY, upstream: 'runner#6210' }, /`upstream` must be an https link/u],
      [{ ...ENTRY, upstream: 'http://example.test/issues/1' }, /`upstream` must be an https link/u],
      [{ ...ENTRY, removeWhen: '  ' }, /`removeWhen` must be a non-empty string/u],
      [{ ...ENTRY, removeWhen: undefined }, /`removeWhen` must be a non-empty string/u],
    ];

    for (const [entry, expected] of cases) {
      const fixture = cleanFixture();
      fixture.write({ 'patches.ledger.json': JSON.stringify({ [KEY]: entry }) });

      expect(only(fixture)).toMatch(expected);
    }
  });

  test('reports a reviewBy that is missing, unreadable, not a real date or in the past', () => {
    const cases: Record<string, RegExp> = {
      '': /not a yyyy-MM-dd date/u,
      soon: /not a yyyy-MM-dd date/u,
      '2026-13-45': /not a real date/u,
      '2026-02-31': /not a real date/u,
      [PAST]:
        /was due for review on 2026-10-12\. Check https:\/\/example\.test\/runner\/issues\/6210/u,
    };

    for (const [reviewBy, expected] of Object.entries(cases)) {
      const fixture = cleanFixture();
      fixture.write({ 'patches.ledger.json': JSON.stringify({ [KEY]: { ...ENTRY, reviewBy } }) });

      expect(only(fixture)).toMatch(expected);
    }

    const undated = cleanFixture();
    const withoutDate: Partial<typeof ENTRY> = { ...ENTRY };
    delete withoutDate.reviewBy;
    undated.write({ 'patches.ledger.json': JSON.stringify({ [KEY]: withoutDate }) });
    expect(only(undated)).toMatch(/`reviewBy` is missing/u);
  });

  test('accepts a reviewBy of today: the entry is due after the day, not on it', () => {
    const fixture = cleanFixture();
    fixture.write({
      'patches.ledger.json': JSON.stringify({ [KEY]: { ...ENTRY, reviewBy: '2026-10-13' } }),
    });

    // Midnight is the one instant an "is it past midnight UTC" comparison gets
    // right, so the day is walked: its first second, 01:00 at UTC+1 and UTC+2,
    // the afternoon, its last second.
    for (const now of [
      '2026-10-13T00:00:00Z',
      '2026-10-13T00:00:01Z',
      '2026-10-13T01:00:00+01:00',
      '2026-10-13T01:00:00+02:00',
      '2026-10-13T15:30:00Z',
      '2026-10-13T23:59:59Z',
    ]) {
      expect(check(fixture, new Date(now))).toEqual([]);
    }
  });

  test('reports the entry from the first second of the day after its reviewBy', () => {
    const fixture = cleanFixture();
    fixture.write({
      'patches.ledger.json': JSON.stringify({ [KEY]: { ...ENTRY, reviewBy: '2026-10-13' } }),
    });

    for (const now of ['2026-10-14T00:00:00Z', '2026-10-14T00:00:01Z', '2027-01-01T12:00:00Z']) {
      const violations = check(fixture, new Date(now));
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message ?? '').toMatch(/was due for review on 2026-10-13/u);
    }
  });

  test('lets the ledger describe itself in a $comment, and reads nothing else as a comment', () => {
    const fixture = cleanFixture();
    fixture.write({
      'patches.ledger.json': JSON.stringify({ $comment: 'what this file is', [KEY]: ENTRY }),
    });
    expect(check(fixture)).toEqual([]);

    fixture.write({
      'patches.ledger.json': JSON.stringify({ $comment: { reason: 'x' }, [KEY]: ENTRY }),
    });
    expect(only(fixture)).toMatch(/`\$comment` must be a string/u);

    fixture.write({ 'patches.ledger.json': JSON.stringify({ $note: 'x', [KEY]: ENTRY }) });
    expect(only(fixture)).toMatch(/`\$note` has a ledger entry but no matching/u);
  });

  test('reports a key that pins no exact version', () => {
    for (const key of ['@scope/runner', '@scope/runner@^10.0.0', 'runner@10']) {
      const fixture = createFixture({
        'pnpm-workspace.yaml': workspace({ [key]: PATCH_PATH }),
        'patches.ledger.json': JSON.stringify({ [key]: ENTRY }),
        [PATCH_PATH]: PATCH,
        'pnpm-lock.yaml': lockfile({ [key]: { hash: patchFileHash(PATCH), path: PATCH_PATH } }),
      });

      expect(only(fixture).startsWith(`\`${key}\` does not pin an exact version`)).toBe(true);
    }
  });

  test('reports a patch file that does not exist', () => {
    const fixture = createFixture({
      'pnpm-workspace.yaml': workspace({ [KEY]: PATCH_PATH }),
      'patches.ledger.json': JSON.stringify({ [KEY]: ENTRY }),
      'pnpm-lock.yaml': lockfile({ [KEY]: { hash: patchFileHash(PATCH), path: PATCH_PATH } }),
    });

    const violations = check(fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(PATCH_PATH);
    expect(violations[0]?.message ?? '').toMatch(/which does not exist/u);
  });

  test('reports a patch file that changed since the lockfile recorded its hash', () => {
    const fixture = cleanFixture();
    fixture.write({ [PATCH_PATH]: PATCH.replace('fixed();', 'fixed(); alsoThis();') });

    const violations = check(fixture);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('pnpm-lock.yaml');
    expect(violations[0]?.message ?? '').toMatch(
      /hashes to [0-9a-f]{12} but pnpm-lock\.yaml locks [0-9a-f]{12}\. The patch file changed/u,
    );
  });

  test('reports a lockfile that does not record the patch, or locks it at another path', () => {
    const unrecorded = cleanFixture();
    unrecorded.write({ 'pnpm-lock.yaml': lockfile({}) });
    expect(only(unrecorded)).toMatch(/pnpm-lock\.yaml does not record the patch/u);

    const elsewhere = cleanFixture();
    elsewhere.write({
      'pnpm-lock.yaml': lockfile({
        [KEY]: { hash: patchFileHash(PATCH), path: 'patches/other.patch' },
      }),
    });
    expect(only(elsewhere)).toMatch(/but pnpm-lock\.yaml locks patches\/other\.patch/u);
  });

  test('reports a patchedDependencies block it cannot read, instead of reading it as empty', () => {
    const inline = cleanFixture();
    inline.write({
      'pnpm-workspace.yaml': `packages:\n  - 'apps/*'\npatchedDependencies: { '${KEY}': ${PATCH_PATH} }\n`,
    });
    const inlineMessages = messages(check(inline));
    expect(inlineMessages.some((message) => /is written on one line/u.test(message))).toBe(true);

    const nested = cleanFixture();
    nested.write({
      'pnpm-workspace.yaml': `patchedDependencies:\n  '${KEY}': ${PATCH_PATH}\n  - not-an-entry\n`,
    });
    expect(only(nested)).toMatch(/holds a line this rule cannot read \("- not-an-entry"\)/u);
  });

  test('reads a patch the root manifest declares the same way as one the workspace file does', () => {
    const fixture = createFixture({
      'package.json': JSON.stringify({
        name: 'fixture',
        pnpm: { patchedDependencies: { [KEY]: PATCH_PATH } },
      }),
      [PATCH_PATH]: PATCH,
      'pnpm-lock.yaml': lockfile({ [KEY]: { hash: patchFileHash(PATCH), path: PATCH_PATH } }),
    });

    expect(only(fixture)).toMatch(/patches\.ledger\.json does not exist/u);

    fixture.write({ 'patches.ledger.json': JSON.stringify({ [KEY]: ENTRY }) });
    expect(check(fixture)).toEqual([]);
  });

  test('reads both files the way pnpm writes them', () => {
    const ctx = cleanFixture().ctx();

    expect([...(readPatchedDependencies(ctx)?.patches ?? [])]).toEqual([[KEY, PATCH_PATH]]);
    expect([...(readLockfilePatches(ctx) ?? [])]).toEqual([
      [KEY, { hash: patchFileHash(PATCH), path: PATCH_PATH }],
    ]);
    // A patch checked out with CRLF line ends hashes the same: pnpm reads them as LF.
    expect(patchFileHash(PATCH.replace(/\n/gu, '\r\n'))).toBe(patchFileHash(PATCH));
  });

  test('reads the ledger and lockfile at configured paths, judged by the configured clock', () => {
    const fixture = createFixture({
      'pnpm-workspace.yaml': workspace({ [KEY]: PATCH_PATH }),
      'deps/patches.json': JSON.stringify({ [KEY]: { ...ENTRY, reviewBy: '2026-10-13' } }),
      [PATCH_PATH]: PATCH,
      'deps/pnpm-lock.yaml': lockfile({ [KEY]: { hash: patchFileHash(PATCH), path: PATCH_PATH } }),
    });
    const options = { ledger: 'deps/patches.json', lockfile: 'deps/pnpm-lock.yaml' };

    const onTime = createPnpmPatchLedgerRule({ ...options, now: () => TODAY });
    expect(runSync(onTime, fixture.ctx())).toEqual([]);
    expect(onTime.description).toContain('deps/patches.json');

    const late = createPnpmPatchLedgerRule({
      ...options,
      now: () => new Date('2026-10-14T00:00:00Z'),
    });
    const violations = runSync(late, fixture.ctx());
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('deps/patches.json');
  });

  test('runs through the rule factory with the real clock by default', () => {
    const fixture = cleanFixture();
    fixture.write({ 'patches.ledger.json': JSON.stringify({}) });

    const violations = runSync(createPnpmPatchLedgerRule(), fixture.ctx());

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('pnpm-patch-ledger');
  });
});
