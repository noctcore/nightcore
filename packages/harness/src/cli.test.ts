import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { type CliIO, nodeIO, runCli } from './cli.js';
import type { SpawnResult } from './run.js';

interface Harness {
  io: CliIO;
  out: string[];
  err: string[];
  readPaths: string[];
}

function harness(overrides: Partial<CliIO> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const readPaths: string[] = [];
  const io: CliIO = {
    cwd: '/repo',
    read: (p) => {
      readPaths.push(p);
      return null;
    },
    spawn: (): SpawnResult => ({ status: 0, signal: null, stdout: '', stderr: '' }),
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...overrides,
  };
  return { io, out, err, readPaths };
}

function manifest(checks: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, checks });
}

describe('runCli — flags', () => {
  test('--help prints usage and exits 0', () => {
    const h = harness();
    expect(runCli(['--help'], h.io)).toBe(0);
    expect(h.out.join('\n')).toContain('Usage:');
  });

  test('--version prints the package version and exits 0', () => {
    const h = harness();
    expect(runCli(['--version'], h.io)).toBe(0);
    // Matches the version the package.json declares.
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(h.out[0]).toBe(pkg.version);
  });

  test('an unknown subcommand is a usage error (exit 2)', () => {
    const h = harness();
    expect(runCli(['lint-meta'], h.io)).toBe(2);
    expect(h.err.join('\n')).toContain('Unknown command');
  });
});

describe('runCli check — opt-in-by-presence', () => {
  test('an absent manifest exits 0 with a friendly note', () => {
    const h = harness();
    expect(runCli(['check'], h.io)).toBe(0);
    expect(h.out.join('\n')).toContain('No structure lock configured');
  });

  test('--dir resolves the manifest under the target directory', () => {
    const h = harness();
    runCli(['check', '--dir', '/some/where'], h.io);
    expect(h.readPaths[0]).toBe(path.join('/some/where', '.nightcore', 'harness.json'));
  });

  test('an absent manifest with --json emits a passing result', () => {
    const h = harness();
    expect(runCli(['check', '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out[0] ?? '')).toEqual({ passed: true, checks: [] });
  });
});

describe('runCli check — schemaVersion gate', () => {
  test('a newer MAJOR reds the build with an upgrade message', () => {
    const h = harness({ read: () => manifest([], { schemaVersion: 2 }) });
    expect(runCli(['check'], h.io)).toBe(1);
    expect(h.err.join('\n')).toContain('upgrade @nightcore/harness');
  });
});

describe('runCli check — verdicts', () => {
  const passing = manifest([{ name: 'lint', kind: 'lint-plugin', command: 'npx eslint .' }]);

  test('every check passing exits 0 and echoes the command (legibility)', () => {
    const h = harness({
      read: () => passing,
      spawn: () => ({ status: 0, signal: null, stdout: '', stderr: '' }),
    });
    expect(runCli(['check'], h.io)).toBe(0);
    const stdout = h.out.join('\n');
    expect(stdout).toContain('→ lint: npx eslint .');
    expect(stdout).toContain('Structure lock passed');
  });

  test('a failing check exits 1 and prints the fix instruction', () => {
    const h = harness({
      read: () => passing,
      spawn: () => ({ status: 1, signal: null, stdout: 'nope', stderr: '' }),
    });
    expect(runCli(['check'], h.io)).toBe(1);
    expect(h.err.join('\n')).toContain('did not pass');
    expect(h.err.join('\n')).toContain('Command: npx eslint .');
  });

  test('--json emits the StructureLockResult shape and the verdict matches the human path', () => {
    const read = () =>
      manifest([
        { name: 'a', kind: 'lint-plugin', command: 'run a' },
        { name: 'b', kind: 'lint-plugin', command: 'run b' },
      ]);
    // First check fails, second passes → overall fail; the JSON reflects both
    // (full-run: the second still ran after the first failed).
    const failFirst = (_program: string, args: string[]): SpawnResult =>
      args[0] === 'a'
        ? { status: 2, signal: null, stdout: 'x', stderr: '' }
        : { status: 0, signal: null, stdout: '', stderr: '' };

    const jsonRun = harness({ read, spawn: failFirst });
    const code = runCli(['check', '--json'], jsonRun.io);
    expect(code).toBe(1);
    const payload = JSON.parse(jsonRun.out[0] ?? '') as {
      passed: boolean;
      checks: Array<{ name: string; kind: string; command: string; status: string; exitCode?: number }>;
      failedCheck?: string;
    };
    expect(payload.passed).toBe(false);
    expect(payload.failedCheck).toBe('a');
    expect(payload.checks).toHaveLength(2);
    expect(payload.checks[0]).toMatchObject({ name: 'a', kind: 'lint-plugin', status: 'failed', exitCode: 2 });
    expect(payload.checks[1]).toMatchObject({ name: 'b', status: 'passed' });

    // The human path reaches the same verdict.
    const humanRun = harness({ read, spawn: failFirst });
    expect(runCli(['check'], humanRun.io)).toBe(1);
    // In --json mode the legibility echo goes to stderr (stdout stays pure JSON).
    expect(jsonRun.err.join('\n')).toContain('→ a: run a');
    expect(jsonRun.out).toHaveLength(1);
  });
});

// These exercise the REAL node-backed IO (nodeIO) in-process so the fs/spawn
// closures are covered and the runner is proven against actual subprocesses.
describe('runCli check — real nodeIO over a fixture directory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nc-harness-cli-'));
    mkdirSync(path.join(dir, '.nightcore'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(checks: unknown[]): void {
    writeFileSync(path.join(dir, '.nightcore', 'harness.json'), manifest(checks), 'utf8');
  }

  /** nodeIO but with captured stdout/stderr (still real fs + real spawn). */
  function quietNodeIO(): { io: CliIO; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { ...nodeIO(), stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
      out,
      err,
    };
  }

  test('a passing check (node -e process.exit(0)) exits 0', () => {
    writeManifest([{ name: 'ok', kind: 'lint-plugin', command: 'node -e process.exit(0)' }]);
    const q = quietNodeIO();
    expect(runCli(['check', '--dir', dir], q.io)).toBe(0);
  });

  test('a failing check (node -e process.exit(1)) exits 1', () => {
    writeManifest([{ name: 'bad', kind: 'lint-plugin', command: 'node -e process.exit(1)' }]);
    const q = quietNodeIO();
    expect(runCli(['check', '--dir', dir], q.io)).toBe(1);
  });
});

// A couple of runs through the un-wrapped nodeIO so its stdout/stderr writers
// are exercised too (writes a short line to the real streams).
describe('nodeIO writers', () => {
  test('--version through the real nodeIO', () => {
    expect(runCli(['--version'], nodeIO())).toBe(0);
  });
  test('an unknown command through the real nodeIO exits 2', () => {
    expect(runCli(['definitely-not-a-command'], nodeIO())).toBe(2);
  });
});
