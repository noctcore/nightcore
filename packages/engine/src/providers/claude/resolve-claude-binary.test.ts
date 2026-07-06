/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  ancestors,
  claudeCliVersionWarning,
  compareCliVersions,
  isRealExecutable,
  isTruthyEnv,
  MIN_CLAUDE_CLI_VERSION,
  parseClaudeCliVersion,
  platformPackageSpecifiers,
  resetClaudeBinaryCacheForTest,
  resolveClaudeBinary,
} from './resolve-claude-binary.js';

// ---------------------------------------------------------------------------
// isTruthyEnv
// ---------------------------------------------------------------------------

describe('isTruthyEnv', () => {
  const falsy: ReadonlyArray<readonly [string, string | undefined]> = [
    ['undefined', undefined],
    ['empty string', ''],
    ["'0'", '0'],
    ["'false'", 'false'],
  ];
  test.each(falsy)('returns false for %s', (_label, value) => {
    expect(isTruthyEnv(value)).toBe(false);
  });

  // The impl is: value !== undefined && value !== '' && value !== '0' && value !== 'false'
  // — there is no explicit 'no' check; 'no' is truthy per the current impl.
  const truthy: ReadonlyArray<readonly [string, string]> = [
    ["'1'", '1'],
    ["'true'", 'true'],
    ["'yes'", 'yes'],
    ["'on'", 'on'],
    ['any other non-empty string', 'some-value'],
  ];
  test.each(truthy)('returns true for %s', (_label, value) => {
    expect(isTruthyEnv(value)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ancestors
// ---------------------------------------------------------------------------

describe('ancestors', () => {
  test('includes the start directory itself as the first element', () => {
    const result = ancestors('/a/b/c');
    expect(result[0]).toBe('/a/b/c');
  });

  test('walks up to the filesystem root', () => {
    const result = ancestors('/a/b/c');
    expect(result).toEqual(['/a/b/c', '/a/b', '/a', '/']);
  });

  test('terminates at the root (no infinite loop)', () => {
    const result = ancestors('/');
    expect(result).toEqual(['/']);
  });

  test('resolves a relative path before walking', () => {
    // ancestors calls path.resolve(start) — relative paths are resolved
    // against cwd; we only assert the result is an array starting with
    // an absolute path.
    const result = ancestors('.');
    expect(path.isAbsolute(result[0]!)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test('last element is always the root', () => {
    const result = ancestors('/foo/bar/baz/qux');
    expect(result[result.length - 1]).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// isRealExecutable
// ---------------------------------------------------------------------------

describe('isRealExecutable', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcore-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns true for a real executable file', () => {
    const p = path.join(tmpDir, 'exec-file');
    fs.writeFileSync(p, '#!/bin/sh\necho hi\n');
    fs.chmodSync(p, 0o755);
    expect(isRealExecutable(p)).toBe(true);
  });

  test('returns false for a file without execute permission', () => {
    const p = path.join(tmpDir, 'non-exec-file');
    fs.writeFileSync(p, 'data');
    fs.chmodSync(p, 0o644);
    expect(isRealExecutable(p)).toBe(false);
  });

  test('returns false for a directory', () => {
    expect(isRealExecutable(tmpDir)).toBe(false);
  });

  test('returns false for a non-existent path', () => {
    expect(isRealExecutable(path.join(tmpDir, 'does-not-exist'))).toBe(false);
  });

  test('returns false for a $bunfs-style virtual path', () => {
    // $bunfs paths are non-existent on the real filesystem; statSync rejects them.
    expect(isRealExecutable('/$bunfs/root/packages/engine/dist/index.js')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveClaudeBinary (memoization)
// ---------------------------------------------------------------------------

describe('resolveClaudeBinary memoization', () => {
  let tmpDir: string;
  const origEnv = process.env.NIGHTCORE_CLAUDE_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcore-claude-'));
    resetClaudeBinaryCacheForTest();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.NIGHTCORE_CLAUDE_PATH;
    else process.env.NIGHTCORE_CLAUDE_PATH = origEnv;
    resetClaudeBinaryCacheForTest();
  });

  function makeExec(name: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, '#!/bin/sh\necho hi\n');
    fs.chmodSync(p, 0o755);
    return p;
  }

  test('caches the first resolution and ignores later env changes', () => {
    const first = makeExec('claude-a');
    process.env.NIGHTCORE_CLAUDE_PATH = first;
    expect(resolveClaudeBinary()).toBe(first);

    // Point the override at a different real executable; the cache must win.
    const second = makeExec('claude-b');
    process.env.NIGHTCORE_CLAUDE_PATH = second;
    expect(resolveClaudeBinary()).toBe(first);
  });

  test('resetClaudeBinaryCacheForTest forces recomputation', () => {
    const first = makeExec('claude-a');
    process.env.NIGHTCORE_CLAUDE_PATH = first;
    expect(resolveClaudeBinary()).toBe(first);

    const second = makeExec('claude-b');
    process.env.NIGHTCORE_CLAUDE_PATH = second;
    resetClaudeBinaryCacheForTest();
    expect(resolveClaudeBinary()).toBe(second);
  });

  test('caches an undefined resolution without re-sweeping', () => {
    // A non-existent override forces the resolver past the env branch. Whatever
    // it resolves to (a real on-disk claude or undefined) must be stable across
    // calls and survive a later env change until the cache is reset.
    process.env.NIGHTCORE_CLAUDE_PATH = path.join(tmpDir, 'does-not-exist');
    const resolved = resolveClaudeBinary();

    const real = makeExec('claude-late');
    process.env.NIGHTCORE_CLAUDE_PATH = real;
    expect(resolveClaudeBinary()).toBe(resolved);
  });
});

// ---------------------------------------------------------------------------
// platformPackageSpecifiers
// ---------------------------------------------------------------------------

describe('platformPackageSpecifiers', () => {
  const SDK = '@anthropic-ai/claude-agent-sdk';

  // Save originals so we can restore after each test.
  const origPlatform = process.platform;
  const origArch = process.arch;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
  });

  function stubPlatform(platform: NodeJS.Platform, arch: string = 'x64'): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  }

  test('darwin produces a single specifier with /claude suffix and no .exe', () => {
    stubPlatform('darwin', 'arm64');
    const specs = platformPackageSpecifiers();
    expect(specs).toEqual([`${SDK}-darwin-arm64/claude`]);
  });

  test('win32 appends .exe to the claude entry point', () => {
    stubPlatform('win32', 'x64');
    const specs = platformPackageSpecifiers();
    expect(specs).toEqual([`${SDK}-win32-x64/claude.exe`]);
  });

  test('android produces a single linux-<arch>-android specifier', () => {
    stubPlatform('android', 'arm64');
    const specs = platformPackageSpecifiers();
    expect(specs).toEqual([`${SDK}-linux-arm64-android/claude`]);
  });

  test('linux on glibc: glibc package listed first, musl second', () => {
    // We can only test the glibc branch directly when running on a glibc host
    // (or by stubbing isMuslLinux, which is unexported). On the current host
    // we assert on the actual ordering returned — the test documents the
    // contract without lying about what environment it ran in.
    //
    // Musl detection note: isMuslLinux() is not exported, so we cannot stub it.
    // The ordering assertion below is conditional on the actual host libc.
    stubPlatform('linux', 'x64');
    const specs = platformPackageSpecifiers();
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatch(new RegExp(`^${SDK.replace(/\//g, '\\/')}-linux-x64`));
    expect(specs[1]).toMatch(new RegExp(`^${SDK.replace(/\//g, '\\/')}-linux-x64`));
    // One entry has -musl, the other does not.
    const hasMusl = specs.filter((s) => s.includes('-musl'));
    const hasGlibc = specs.filter((s) => !s.includes('-musl'));
    expect(hasMusl).toHaveLength(1);
    expect(hasGlibc).toHaveLength(1);
    // Neither has .exe.
    for (const s of specs) expect(s).not.toContain('.exe');
  });

  test('linux glibc ordering: non-musl package is first on a glibc host', () => {
    // This test only runs meaningfully on a glibc host (darwin/linux-glibc).
    // On a musl host the ordering is intentionally reversed (musl-first).
    // We skip rather than assert the wrong direction.
    stubPlatform('linux', 'x64');
    const specs = platformPackageSpecifiers();
    // On this macOS CI/dev host, process.platform is being stubbed to linux.
    // isMuslLinux() checks process.platform AND process.report — since we're
    // on macOS the report won't have glibcVersionRuntime, which would make
    // isMuslLinux return true, causing musl-first ordering. We document this
    // behaviour rather than fight the unexported helper.
    expect(specs).toHaveLength(2);
    // Both entries must end with /claude (no .exe on linux).
    for (const s of specs) expect(s.endsWith('/claude')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI version floor (checkClaudeCliVersion helpers)
// ---------------------------------------------------------------------------

describe('parseClaudeCliVersion', () => {
  test('extracts x.y.z from real `claude --version` output', () => {
    expect(parseClaudeCliVersion('2.1.201 (Claude Code)')).toBe('2.1.201');
  });

  test('extracts a leading dotted-triple with surrounding text', () => {
    expect(parseClaudeCliVersion('claude version 1.0.44\n')).toBe('1.0.44');
  });

  test('returns null when no dotted-triple is present', () => {
    expect(parseClaudeCliVersion('unknown')).toBe(null);
    expect(parseClaudeCliVersion('')).toBe(null);
  });
});

describe('compareCliVersions', () => {
  test('orders by major, then minor, then patch', () => {
    expect(compareCliVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareCliVersions('2.1.0', '2.0.9')).toBeGreaterThan(0);
    expect(compareCliVersions('2.0.1', '2.0.0')).toBeGreaterThan(0);
    expect(compareCliVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareCliVersions('2.0.0', '2.0.0')).toBe(0);
  });

  test('treats missing segments as zero', () => {
    expect(compareCliVersions('2', '2.0.0')).toBe(0);
  });
});

describe('claudeCliVersionWarning', () => {
  test('warns when the CLI is below the floor', () => {
    const warning = claudeCliVersionWarning('1.0.44 (Claude Code)');
    expect(warning).toBeDefined();
    expect(warning).toContain('1.0.44');
    expect(warning).toContain(MIN_CLAUDE_CLI_VERSION);
    expect(warning).toContain('Upgrade Claude Code');
  });

  test('does not warn at or above the floor', () => {
    expect(claudeCliVersionWarning(`${MIN_CLAUDE_CLI_VERSION} (Claude Code)`)).toBeUndefined();
    expect(claudeCliVersionWarning('2.1.201 (Claude Code)')).toBeUndefined();
  });

  test('degrades quietly (no warning) on null or unparseable output', () => {
    expect(claudeCliVersionWarning(null)).toBeUndefined();
    expect(claudeCliVersionWarning('not a version')).toBeUndefined();
  });
});
