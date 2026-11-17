import { describe, expect, test } from 'bun:test';

import type { IToolPin } from './pins.js';
import { ACTIONLINT, WORKFLOW_LINTER_TOOLS, ZIZMOR } from './pins.js';
import type { IRunDeps, LinterRoute } from './route.js';
import { chooseRoute, exitCodeFor, lintArgs, linterVerdict, parseVersion, runLinter } from './route.js';

const ROOT = '/work/repo';
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/images.yml'];

function versions(found: Partial<Record<string, string | null>>) {
  return (tool: IToolPin): string | null => found[tool.name] ?? null;
}

function deps(overrides: Partial<IRunDeps> = {}): IRunDeps & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    workflows: () => WORKFLOWS,
    nativeVersion: versions({}),
    dockerAvailable: () => true,
    imagePresent: () => true,
    pull: (image) => {
      calls.push(`pull ${image}`);
      return true;
    },
    spawn: (command, args) => {
      calls.push([command, ...args].join(' '));
      return 0;
    },
    ...overrides,
  };
}

describe('workflow linter pins', () => {
  test('pins every image by digest and every archive by sha256', () => {
    for (const pin of [ZIZMOR, ACTIONLINT]) {
      expect(pin.image).toMatch(/:[0-9.]+@sha256:[0-9a-f]{64}$/u);
      expect(pin.image).toContain(`:${pin.version}@`);
    }
    for (const tool of WORKFLOW_LINTER_TOOLS) {
      for (const arch of ['x64', 'arm64'] as const) {
        const archive = tool.linux[arch];
        expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(archive.path).toContain(tool.version);
        expect(archive.path).toMatch(/^[\w.-]+\/[\w.-]+\/releases\/download\//u);
      }
      expect(tool.linux.x64.sha256).not.toBe(tool.linux.arm64.sha256);
    }
  });

  test('lists every tool the native route asks for', () => {
    const needed = [ZIZMOR, ACTIONLINT, ...ZIZMOR.needs, ...ACTIONLINT.needs].map((t) => t.name);
    expect([...new Set(needed)].sort()).toEqual(
      WORKFLOW_LINTER_TOOLS.map((tool) => tool.name).sort(),
    );
  });
});

describe('parseVersion', () => {
  test("reads each tool's own --version shape", () => {
    expect(parseVersion('zizmor 1.30.1\n')).toBe('1.30.1');
    expect(parseVersion('1.7.12\ninstalled by building from source\n')).toBe('1.7.12');
    expect(parseVersion('ShellCheck - shell script analysis tool\nversion: 0.11.0\n')).toBe(
      '0.11.0',
    );
    expect(parseVersion('no version here')).toBeNull();
  });
});

describe('lintArgs', () => {
  test('refuses a linter it has no arguments for', () => {
    expect(() => lintArgs({ ...ZIZMOR, name: 'other' }, 'native', WORKFLOWS)).toThrow(
      /no arguments are known for the linter "other"/u,
    );
  });
});

describe('chooseRoute', () => {
  test('runs a native tool that reports exactly the pinned version', () => {
    const route = chooseRoute(
      ZIZMOR,
      ROOT,
      WORKFLOWS,
      deps({ nativeVersion: versions({ zizmor: '1.30.1' }) }),
    );
    expect(route.kind).toBe('native');
    expect(route.kind === 'native' ? route.args : []).toEqual([
      '--offline',
      '--no-progress',
      ...WORKFLOWS,
    ]);
  });

  test('refuses a native tool of another version and takes the pinned image', () => {
    const route = chooseRoute(
      ZIZMOR,
      ROOT,
      WORKFLOWS,
      deps({ nativeVersion: versions({ zizmor: '1.29.0' }) }),
    );
    expect(route.kind).toBe('docker');
    const args = route.kind === 'docker' ? route.args : [];
    expect(args.slice(0, 8)).toEqual([
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '-v',
      `${ROOT}:/repo:ro`,
      '-w',
      '/repo',
    ]);
    expect(args[8]).toBe(ZIZMOR.image);
  });

  test('needs actionlint AND its pinned shellcheck native, else the image that bundles both', () => {
    const both = chooseRoute(
      ACTIONLINT,
      ROOT,
      WORKFLOWS,
      deps({ nativeVersion: versions({ actionlint: '1.7.12', shellcheck: '0.11.0' }) }),
    );
    expect(both.kind).toBe('native');
    expect(both.kind === 'native' && both.args.includes('-shellcheck=shellcheck')).toBe(true);
    const oldShellcheck = chooseRoute(
      ACTIONLINT,
      ROOT,
      WORKFLOWS,
      deps({ nativeVersion: versions({ actionlint: '1.7.12', shellcheck: '0.9.0' }) }),
    );
    expect(oldShellcheck.kind).toBe('docker');
    expect(oldShellcheck.kind === 'docker' && !oldShellcheck.args.includes('--platform')).toBe(
      true,
    );
  });

  test('is blocked, naming what is missing, with neither a pinned native tool nor Docker', () => {
    const route = chooseRoute(
      ACTIONLINT,
      ROOT,
      WORKFLOWS,
      deps({ nativeVersion: versions({ actionlint: '1.7.11' }), dockerAvailable: () => false }),
    );
    expect(route.kind).toBe('blocked');
    const reason = route.kind === 'blocked' ? route.reason : '';
    expect(reason).toMatch(/native actionlint 1\.7\.11 is not the pinned 1\.7\.12/u);
    expect(reason).toMatch(/no native shellcheck/u);
    expect(reason).toMatch(/actionlint 1\.7\.12 and shellcheck 0\.11\.0/u);
  });

  test('names the workflow files on both routes, so nothing depends on a visible .git', () => {
    for (const nativeVersion of [
      versions({ actionlint: '1.7.12', shellcheck: '0.11.0' }),
      versions({}),
    ]) {
      const route = chooseRoute(ACTIONLINT, ROOT, WORKFLOWS, deps({ nativeVersion }));
      const args = route.kind === 'blocked' ? [] : route.args;
      expect(args.slice(-2)).toEqual(WORKFLOWS);
      expect(args).toContain('-pyflakes=');
    }
  });
});

describe('linterVerdict', () => {
  const native: LinterRoute = { kind: 'native', command: 'zizmor', args: [] };
  const image: LinterRoute = { kind: 'docker', image: ZIZMOR.image, args: [] };

  test('passes only a clean exit, and fails any finding or tool error', () => {
    expect(linterVerdict(native, 0).status).toBe('passed');
    for (const code of [1, 2, 3, 10, 11, 12, 13, 14]) {
      expect(linterVerdict(native, code).status).toBe('failed');
      expect(linterVerdict(image, code).status).toBe('failed');
    }
  });

  test('keeps a blocked route blocked whatever exit code it is handed', () => {
    const blocked: LinterRoute = { kind: 'blocked', reason: 'no tool' };
    for (const code of [0, 1, 2, 125]) {
      expect(linterVerdict(blocked, code)).toEqual({ status: 'blocked', reason: 'no tool' });
    }
  });

  test("reads docker's own 125 as blocked: the linter never ran", () => {
    expect(linterVerdict(image, 125).status).toBe('blocked');
    expect(linterVerdict(native, 125).status).toBe('failed');
  });

  test('exits 0 passed, 1 failed, 2 blocked', () => {
    expect((['passed', 'failed', 'blocked'] as const).map(exitCodeFor)).toEqual([0, 1, 2]);
  });
});

describe('runLinter', () => {
  test('is blocked, exits 2 and runs nothing with no native tool and no Docker', () => {
    for (const pin of [ZIZMOR, ACTIONLINT]) {
      const run = deps({ dockerAvailable: () => false });
      const result = runLinter(pin, ROOT, run);
      expect(result.status).toBe('blocked');
      expect(exitCodeFor(result.status)).toBe(2);
      expect(run.calls).toEqual([]);
    }
  });

  test('pulls a missing image before running it', () => {
    const run = deps({ imagePresent: () => false });
    const result = runLinter(ZIZMOR, ROOT, run);
    expect(result.status).toBe('passed');
    expect(run.calls[0]).toBe(`pull ${ZIZMOR.image}`);
    expect(run.calls[1] ?? '').toMatch(/^docker run --rm/u);
  });

  test('is blocked when the image cannot be pulled, and runs nothing', () => {
    const run = deps({ imagePresent: () => false, pull: () => false });
    expect(runLinter(ZIZMOR, ROOT, run).status).toBe('blocked');
    expect(run.calls).toEqual([]);
  });

  test('fails a tree with no workflow files instead of passing it', () => {
    const run = deps({ workflows: () => [] });
    expect(runLinter(ACTIONLINT, ROOT, run).status).toBe('failed');
    expect(run.calls).toEqual([]);
  });

  test('is blocked when the tool could not be started', () => {
    const run = deps({ nativeVersion: versions({ zizmor: '1.30.1' }), spawn: () => null });
    expect(runLinter(ZIZMOR, ROOT, run).status).toBe('blocked');
  });

  test('reports the findings exit of a native run as failed', () => {
    const run = deps({ nativeVersion: versions({ zizmor: '1.30.1' }), spawn: () => 14 });
    const result = runLinter(ZIZMOR, ROOT, run);
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/exit 14, native/u);
  });
});
