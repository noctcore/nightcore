import { describe, expect, test } from 'bun:test';

import type { IGitleaksDeps, IGitleaksRunDeps } from './gitleaks.js';
import {
  chooseGitleaksRoute,
  gitleaksArgs,
  imageVersion,
  pinnedGitleaksVersion,
  runGitleaks,
} from './gitleaks.js';
import { GITLEAKS_IMAGE } from './pins.js';
import { exitCodeFor } from './route.js';

const ROOT = '/work/repo';
const VERSION = imageVersion(GITLEAKS_IMAGE) ?? 'unpinned';

function deps(overrides: Partial<IGitleaksDeps> = {}): IGitleaksDeps {
  return {
    nativeVersion: () => null,
    dockerAvailable: () => true,
    gitDirIsLocal: () => true,
    ...overrides,
  };
}

describe('pinnedGitleaksVersion', () => {
  test("reads a workflow's GITLEAKS_VERSION line, quoted or not", () => {
    expect(pinnedGitleaksVersion("    env:\n      GITLEAKS_VERSION: '8.30.1'\n")).toBe('8.30.1');
    expect(pinnedGitleaksVersion('GITLEAKS_VERSION: 8.29.0\n')).toBe('8.29.0');
    expect(pinnedGitleaksVersion('env: {}\n')).toBeNull();
  });

  test('reads another variable when named, and refuses one that is not a plain name', () => {
    expect(pinnedGitleaksVersion('  SCANNER: "8.1.0"\n', 'SCANNER')).toBe('8.1.0');
    expect(() => pinnedGitleaksVersion('x', 'A|B')).toThrow(/not a plain variable name/u);
  });
});

describe('gitleaksArgs', () => {
  test('scans full history with the repo config and fails on any leak', () => {
    const args = gitleaksArgs();
    expect(args.slice(0, 2)).toEqual(['git', '.']);
    expect(args).toContain('.gitleaks.toml');
    expect(args.slice(-2)).toEqual(['--exit-code', '1']);
    expect(gitleaksArgs('config/gitleaks.toml')).toContain('config/gitleaks.toml');
  });
});

describe('the default gitleaks image', () => {
  test('is pinned by digest, and its tag names a version', () => {
    expect(GITLEAKS_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/u);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(imageVersion('ghcr.io/gitleaks/gitleaks:v8.30.1')).toBeNull();
  });
});

describe('chooseGitleaksRoute', () => {
  test("runs a native gitleaks of exactly CI's version", () => {
    const route = chooseGitleaksRoute(VERSION, ROOT, deps({ nativeVersion: () => VERSION }));
    expect(route).toEqual({ kind: 'native', command: 'gitleaks', args: gitleaksArgs() });
  });

  test("refuses another native version and takes CI's image, history mounted read-only", () => {
    const route = chooseGitleaksRoute(VERSION, ROOT, deps({ nativeVersion: () => '8.28.0' }));
    expect(route.kind).toBe('docker');
    const args = route.kind === 'docker' ? route.args : [];
    expect(args.slice(0, 7)).toEqual([
      'run',
      '--rm',
      '-v',
      `${ROOT}:/repo:ro`,
      '-w',
      '/repo',
      GITLEAKS_IMAGE,
    ]);
  });

  test('is blocked with neither the native version nor Docker', () => {
    const route = chooseGitleaksRoute(
      '8.30.1',
      ROOT,
      deps({ nativeVersion: () => '8.28.0', dockerAvailable: () => false }),
    );
    expect(route.kind).toBe('blocked');
    expect(route.kind === 'blocked' ? route.reason : '').toMatch(
      /native gitleaks 8\.28\.0 is not CI's 8\.30\.1/u,
    );
  });

  test('is blocked in a worktree, whose history the image cannot see', () => {
    const route = chooseGitleaksRoute(VERSION, ROOT, deps({ gitDirIsLocal: () => false }));
    expect(route.kind).toBe('blocked');
    expect(route.kind === 'blocked' ? route.reason : '').toMatch(/worktree/u);
  });

  test('is blocked when CI names no version, naming where it looked', () => {
    const route = chooseGitleaksRoute(null, ROOT, deps({ nativeVersion: () => VERSION }), {
      versionSource: '.github/workflows/secrets.yml',
    });
    expect(route).toEqual({
      kind: 'blocked',
      reason: '.github/workflows/secrets.yml names no gitleaks version',
    });
  });

  test("refuses an image whose version is not CI's, rather than scan with another ruleset", () => {
    expect(chooseGitleaksRoute('8.31.0', ROOT, deps()).kind).toBe('blocked');
    const other = 'ghcr.io/gitleaks/gitleaks:v8.31.0@sha256:' + 'a'.repeat(64);
    expect(chooseGitleaksRoute('8.31.0', ROOT, deps(), { image: other }).kind).toBe('docker');
  });
});

describe('runGitleaks', () => {
  function runDeps(overrides: Partial<IGitleaksRunDeps> = {}) {
    const spawned: string[] = [];
    const exit = overrides.spawn ?? (() => 0);
    const base: IGitleaksRunDeps = {
      nativeVersion: () => null,
      dockerAvailable: () => true,
      gitDirIsLocal: () => true,
      ...overrides,
      spawn: (command, args, cwd) => {
        spawned.push(command);
        return exit(command, args, cwd);
      },
    };
    return { deps: base, spawned };
  }

  test('is blocked, exits 2 and scans nothing with no gitleaks and no Docker', () => {
    const { deps: run, spawned } = runDeps({ dockerAvailable: () => false });
    const result = runGitleaks(VERSION, ROOT, run);
    expect(result.status).toBe('blocked');
    expect(exitCodeFor(result.status)).toBe(2);
    expect(spawned).toEqual([]);
  });

  test('is blocked in a worktree without the native version, and when CI names no version', () => {
    expect(runGitleaks(VERSION, ROOT, runDeps({ gitDirIsLocal: () => false }).deps).status).toBe(
      'blocked',
    );
    expect(runGitleaks(null, ROOT, runDeps({ nativeVersion: () => VERSION }).deps).status).toBe(
      'blocked',
    );
  });

  test('is blocked when the scan could not start, or docker itself failed (125)', () => {
    expect(runGitleaks(VERSION, ROOT, runDeps({ spawn: () => null }).deps).status).toBe('blocked');
    expect(runGitleaks(VERSION, ROOT, runDeps({ spawn: () => 125 }).deps).status).toBe('blocked');
  });

  test('passes a clean scan and fails a leak, on either route', () => {
    const native = runDeps({ nativeVersion: () => VERSION, spawn: () => 0 });
    expect(runGitleaks(VERSION, ROOT, native.deps).status).toBe('passed');
    expect(native.spawned).toEqual(['gitleaks']);
    const image = runDeps({ spawn: () => 1 });
    expect(runGitleaks(VERSION, ROOT, image.deps).status).toBe('failed');
    expect(image.spawned).toEqual(['docker']);
  });
});
