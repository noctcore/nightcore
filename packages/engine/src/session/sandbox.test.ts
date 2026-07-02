/// <reference types="bun" />
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildSeatbeltProfile,
  claudeStatePrefixes,
  deriveWritableRoots,
  gitCommonWriteRoots,
  prepareWriteSandbox,
  sandboxAvailable,
  wrapExecutableForSandbox,
} from './sandbox.js';

/** Whether the REAL Seatbelt integration tests can run on this host. The
 *  containment-proof tests are darwin-only by nature; elsewhere they skip. */
const canSandbox =
  process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildSeatbeltProfile
// ---------------------------------------------------------------------------

describe('buildSeatbeltProfile', () => {
  test('emits deny-write-except: version, allow default, deny, one allow per root', () => {
    const profile = buildSeatbeltProfile({
      writableRoots: ['/private/tmp/a', '/Users/x/.claude'],
    });
    const lines = profile.trimEnd().split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(allow default)');
    expect(lines[2]).toBe('(deny file-write*)');
    expect(lines[3]).toBe('(allow file-write* (subpath "/private/tmp/a"))');
    expect(lines[4]).toBe('(allow file-write* (subpath "/Users/x/.claude"))');
    expect(lines).toHaveLength(5);
  });

  test('emits prefix rules after subpath rules', () => {
    const profile = buildSeatbeltProfile({
      writableRoots: ['/w'],
      writablePrefixes: ['/Users/x/.claude.json'],
    });
    expect(profile).toContain(
      '(allow file-write* (prefix "/Users/x/.claude.json"))',
    );
    // Deny must come before any allow-write rule.
    expect(profile.indexOf('(deny file-write*)')).toBeLessThan(
      profile.indexOf('(allow file-write* (subpath "/w"))'),
    );
  });

  test('escapes quotes and backslashes in paths (TinyScheme string literals)', () => {
    const profile = buildSeatbeltProfile({
      writableRoots: ['/tmp/we"ird\\dir'],
    });
    expect(profile).toContain('(subpath "/tmp/we\\"ird\\\\dir")');
  });

  test('no writable roots ⇒ pure deny profile (still well-formed)', () => {
    const profile = buildSeatbeltProfile({ writableRoots: [] });
    expect(profile).toBe('(version 1)\n(allow default)\n(deny file-write*)\n');
  });
});

// ---------------------------------------------------------------------------
// wrapExecutableForSandbox
// ---------------------------------------------------------------------------

describe('wrapExecutableForSandbox', () => {
  test('writes profile + executable wrapper and returns the wrapper path', () => {
    const scratchDir = makeTempDir('nc-sandbox-test-');
    const profile = buildSeatbeltProfile({ writableRoots: ['/w'] });
    const wrapperPath = wrapExecutableForSandbox({
      claudePath: '/opt/claude/bin/claude',
      profile,
      scratchDir,
    });

    expect(wrapperPath.startsWith(scratchDir)).toBe(true);
    const profilePath = path.join(scratchDir, 'write-containment.sb');
    expect(fs.readFileSync(profilePath, 'utf8')).toBe(profile);

    const script = fs.readFileSync(wrapperPath, 'utf8');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('exec /usr/bin/sandbox-exec -f ');
    expect(script).toContain(`'${profilePath}'`);
    expect(script).toContain(`'/opt/claude/bin/claude' "$@"`);

    // 0o755: the SDK must be able to exec it directly.
    const mode = fs.statSync(wrapperPath).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  test('single-quote-escapes embedded quotes in paths', () => {
    const scratchDir = makeTempDir('nc-sandbox-test-');
    const wrapperPath = wrapExecutableForSandbox({
      claudePath: `/odd/pa'th/claude`,
      profile: '(version 1)\n',
      scratchDir,
    });
    const script = fs.readFileSync(wrapperPath, 'utf8');
    expect(script).toContain(`'/odd/pa'\\''th/claude'`);
  });
});

// ---------------------------------------------------------------------------
// gitCommonWriteRoots
// ---------------------------------------------------------------------------

describe('gitCommonWriteRoots', () => {
  test('non-repo cwd ⇒ no roots', () => {
    const cwd = makeTempDir('nc-sandbox-test-');
    expect(gitCommonWriteRoots(cwd)).toEqual([]);
  });

  test('normal checkout (.git is a directory) ⇒ no roots (already under cwd)', () => {
    const cwd = makeTempDir('nc-sandbox-test-');
    fs.mkdirSync(path.join(cwd, '.git'));
    expect(gitCommonWriteRoots(cwd)).toEqual([]);
  });

  test('linked worktree ⇒ the parent repo .git common dir', () => {
    const repo = makeTempDir('nc-sandbox-test-');
    const gitdir = path.join(repo, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(gitdir, { recursive: true });
    const cwd = makeTempDir('nc-sandbox-test-');
    fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${gitdir}\n`);

    const roots = gitCommonWriteRoots(cwd);
    expect(roots).toEqual([fs.realpathSync(path.join(repo, '.git'))]);
  });

  test('gitdir outside a worktrees layout ⇒ the pointed-to dir itself', () => {
    const target = makeTempDir('nc-sandbox-test-');
    const cwd = makeTempDir('nc-sandbox-test-');
    fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${target}\n`);
    expect(gitCommonWriteRoots(cwd)).toEqual([fs.realpathSync(target)]);
  });
});

// ---------------------------------------------------------------------------
// deriveWritableRoots
// ---------------------------------------------------------------------------

describe('deriveWritableRoots', () => {
  test('includes cwd, temp trees, /dev, and the Claude state dirs — canonicalized', () => {
    const cwd = makeTempDir('nc-sandbox-test-');
    const roots = deriveWritableRoots({ cwd });
    const home = os.homedir();

    expect(roots).toContain(fs.realpathSync(cwd));
    expect(roots).toContain('/dev');
    expect(roots).toContain('/private/tmp');
    expect(roots).toContain('/private/var/folders');
    // realpath'd $TMPDIR (on darwin this resolves under /private/var/folders).
    expect(roots).toContain(fs.realpathSync(os.tmpdir()));
    // ~/.claude and the CLI cache dir may not exist on a fresh host — they are
    // included either way (realpath degrades to the resolved input) so the CLI
    // can CREATE them.
    const containsClaudeState = roots.some(
      (r) => r === path.join(home, '.claude') || r.endsWith('/.claude'),
    );
    expect(containsClaudeState).toBe(true);
    const containsCliCache = roots.some((r) =>
      r.endsWith(path.join('Library', 'Caches', 'claude-cli-nodejs')),
    );
    expect(containsCliCache).toBe(true);
  });

  test('deduplicates roots that canonicalize identically', () => {
    const cwd = makeTempDir('nc-sandbox-test-');
    const roots = deriveWritableRoots({ cwd, projectRoot: cwd });
    expect(roots.filter((r) => r === fs.realpathSync(cwd))).toHaveLength(1);
  });

  test('a differing project root is included alongside cwd', () => {
    const cwd = makeTempDir('nc-sandbox-test-');
    const projectRoot = makeTempDir('nc-sandbox-test-');
    const roots = deriveWritableRoots({ cwd, projectRoot });
    expect(roots).toContain(fs.realpathSync(cwd));
    expect(roots).toContain(fs.realpathSync(projectRoot));
  });

  test('worktree cwd pulls in the parent repo git common dir', () => {
    const repo = makeTempDir('nc-sandbox-test-');
    const gitdir = path.join(repo, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(gitdir, { recursive: true });
    const cwd = makeTempDir('nc-sandbox-test-');
    fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${gitdir}\n`);

    const roots = deriveWritableRoots({ cwd });
    expect(roots).toContain(fs.realpathSync(path.join(repo, '.git')));
  });
});

describe('claudeStatePrefixes', () => {
  test('covers the ~/.claude.json family as a prefix', () => {
    expect(claudeStatePrefixes()).toEqual([
      path.join(os.homedir(), '.claude.json'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// sandboxAvailable + REAL containment proof (darwin-only; skipped elsewhere)
// ---------------------------------------------------------------------------

describe('sandboxAvailable', () => {
  test.skipIf(!canSandbox)('darwin with sandbox-exec ⇒ available', () => {
    expect(sandboxAvailable()).toBe(true);
  });

  test.skipIf(canSandbox)('without darwin sandbox-exec ⇒ unavailable', () => {
    expect(sandboxAvailable()).toBe(false);
  });
});

describe('Seatbelt containment (integration, real sandbox-exec)', () => {
  /** Run `/bin/sh -c <cmd>` under a generated profile. */
  function runSandboxed(profilePath: string, cmd: string) {
    return spawnSync(
      '/usr/bin/sandbox-exec',
      ['-f', profilePath, '/bin/sh', '-c', cmd],
      { timeout: 15_000 },
    );
  }

  test.skipIf(!canSandbox)(
    'allows writes inside a writable root and DENIES writes outside it',
    () => {
      const inside = fs.realpathSync(makeTempDir('nc-sandbox-inside-'));
      const outside = fs.realpathSync(makeTempDir('nc-sandbox-outside-'));
      const scratchDir = makeTempDir('nc-sandbox-scratch-');
      // ONLY `inside` is writable — `outside` (a sibling temp dir) is not.
      const profilePath = path.join(scratchDir, 'test.sb');
      fs.writeFileSync(
        profilePath,
        buildSeatbeltProfile({ writableRoots: [inside] }),
      );

      const ok = runSandboxed(profilePath, `echo x > "${inside}/ok.txt"`);
      expect(ok.status).toBe(0);
      expect(fs.readFileSync(path.join(inside, 'ok.txt'), 'utf8')).toBe('x\n');

      const denied = runSandboxed(profilePath, `echo x > "${outside}/no.txt"`);
      expect(denied.status).not.toBe(0);
      expect(fs.existsSync(path.join(outside, 'no.txt'))).toBe(false);
    },
  );

  test.skipIf(!canSandbox)(
    'the exec wrapper produced by prepareWriteSandbox enforces the same containment',
    () => {
      const cwd = fs.realpathSync(makeTempDir('nc-sandbox-cwd-'));
      // Wrap /bin/sh instead of claude: same exec/args pass-through path.
      const prepared = prepareWriteSandbox({ claudePath: '/bin/sh', cwd });
      expect(prepared).toBeDefined();
      if (prepared === undefined) return;
      tempDirs.push(prepared.scratchDir);

      const ok = spawnSync(
        prepared.wrapperPath,
        ['-c', `echo x > "${cwd}/ok.txt"`],
        { timeout: 15_000 },
      );
      expect(ok.status).toBe(0);
      expect(fs.existsSync(path.join(cwd, 'ok.txt'))).toBe(true);

      // `outside` is a temp dir and the default roots allow the temp trees —
      // so prove containment against a NON-temp path instead: a subdir of the
      // repo checkout this test runs from is NOT in the default roots.
      const repoOutside = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        'nc-sandbox-denied-probe.txt',
      );
      const denied = spawnSync(
        prepared.wrapperPath,
        ['-c', `echo x > "${repoOutside}"`],
        { timeout: 15_000 },
      );
      // Capture-then-clean BEFORE asserting so a containment regression can't
      // leave a stray probe file in the repo checkout.
      const leaked = fs.existsSync(repoOutside);
      fs.rmSync(repoOutside, { force: true });
      expect(denied.status).not.toBe(0);
      expect(leaked).toBe(false);
    },
  );
});
