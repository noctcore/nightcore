/**
 * The trap-b gate: the PUBLISHED artifact must run under plain Node, never Bun.
 * Builds the package's own tsup `dist`, then drives the real `dist/cli.js` with
 * `node` (not `bun`) via a subprocess and asserts the built entrypoints import
 * no network or Bun modules. Runs headless (no Nightcore, no network).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const PKG_ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(PKG_ROOT, 'dist');
const CLI = path.join(DIST, 'cli.js');

const fixtures: string[] = [];

function fixtureDir(command: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nc-harness-node-'));
  fixtures.push(dir);
  mkdirSync(path.join(dir, '.nightcore'), { recursive: true });
  writeFileSync(
    path.join(dir, '.nightcore', 'harness.json'),
    JSON.stringify({ checks: [{ name: 'fixture', kind: 'lint-plugin', command }] }),
    'utf8',
  );
  return dir;
}

/** Run the built CLI under plain `node` (explicitly NOT bun). */
function runNode(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

beforeAll(() => {
  // Self-sufficient: build the package's own dist if the gate battery hasn't
  // already (CI's test:node runs before any explicit harness build).
  if (!existsSync(CLI)) {
    const build = spawnSync('bun', ['run', 'build'], { cwd: PKG_ROOT, encoding: 'utf8' });
    if (build.status !== 0) {
      throw new Error(`tsup build failed:\n${build.stdout}\n${build.stderr}`);
    }
  }
}, 120_000);

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

describe('the published CLI runs under plain node (trap b)', () => {
  test('--version runs under node and prints the package version', () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    const res = runNode(['--version']);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(pkg.version);
  });

  test('check on a passing fixture exits 0', () => {
    const res = runNode(['check', '--dir', fixtureDir('node -e process.exit(0)')]);
    expect(res.status).toBe(0);
  });

  test('check on a failing fixture exits 1', () => {
    const res = runNode(['check', '--dir', fixtureDir('node -e process.exit(1)')]);
    expect(res.status).toBe(1);
  });
});

describe('the built dist has no network or Bun imports (supply-chain posture)', () => {
  // Module specifiers that would betray a network dependency or a Bun coupling.
  const FORBIDDEN = [
    "'http'",
    '"http"',
    "'https'",
    '"https"',
    "'net'",
    '"net"',
    "'dns'",
    '"dns"',
    "'tls'",
    '"tls"',
    "'bun'",
    '"bun"',
    'node:http',
    'node:https',
    'node:net',
    'node:dns',
    'node:tls',
    'bun:',
  ];

  test('no forbidden module specifier and no fetch() call in the shipped entrypoints', () => {
    const entrypoints = ['cli.js', 'cli.cjs', 'index.js', 'index.cjs']
      .map((f) => path.join(DIST, f))
      .filter((p) => existsSync(p));
    expect(entrypoints.length).toBeGreaterThan(0);

    for (const file of entrypoints) {
      const body = readFileSync(file, 'utf8');
      for (const needle of FORBIDDEN) {
        expect(body.includes(needle)).toBe(false);
      }
      expect(/\bfetch\s*\(/.test(body)).toBe(false);
    }
  });
});
