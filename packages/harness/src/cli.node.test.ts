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

/**
 * A target dir with a committed lint-meta registry (`.nightcore/lint-meta/registry.js`,
 * CommonJS — the dir has no package.json so `.js` is CJS). `registrySource` is the
 * module body; `strays` are extra sibling files that MUST NOT be imported (bounded
 * eval). Returns the dir.
 */
function lintMetaFixture(registrySource: string, strays: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nc-harness-lm-'));
  fixtures.push(dir);
  const lmDir = path.join(dir, '.nightcore', 'lint-meta');
  mkdirSync(lmDir, { recursive: true });
  writeFileSync(path.join(lmDir, 'registry.js'), registrySource, 'utf8');
  for (const [name, body] of Object.entries(strays)) {
    writeFileSync(path.join(lmDir, name), body, 'utf8');
  }
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

describe('the lint-meta subcommand runs under plain node (trap b, bounded eval)', () => {
  const PASS_REGISTRY = `module.exports = { META_RULES: [
    { id: 'ok', category: 'source-text', description: 'always passes', run: () => [] },
  ] };`;

  // A rule that reports a violation when a committed file matches — exercises the
  // real Node ctx (read/glob) end to end, not just a static return.
  const FAIL_REGISTRY = `module.exports = { META_RULES: [
    { id: 'no-todo', category: 'source-text', description: 'no TODO markers', ciCritical: true,
      run: (ctx) => ctx.read('note.txt')?.includes('TODO')
        ? [{ file: 'note.txt', rule: 'no-todo', message: 'found a TODO' }] : [] },
  ] };`;

  test('lint-meta --help exits 0 under node', () => {
    const res = runNode(['lint-meta', '--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('lint-meta');
  });

  test('an absent registry exits 0 (nothing to enforce)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nc-harness-lm-empty-'));
    fixtures.push(dir);
    const res = runNode(['lint-meta', '--dir', dir]);
    expect(res.status).toBe(0);
  });

  test('a passing CJS registry exits 0', () => {
    const dir = lintMetaFixture(PASS_REGISTRY);
    const res = runNode(['lint-meta', '--dir', dir]);
    expect(res.status).toBe(0);
  });

  test('a violating rule reds the build (exit 1) via the real Node ctx', () => {
    const dir = lintMetaFixture(FAIL_REGISTRY);
    writeFileSync(path.join(dir, 'note.txt'), 'TODO: fix me', 'utf8');
    const res = runNode(['lint-meta', '--dir', dir]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[ERROR] no-todo');
  });

  test('bounded eval: a stray sibling .js is never imported/run', () => {
    // The stray writes a sentinel file if it is ever executed; after a run over the
    // enumerated registry, the sentinel must NOT exist.
    const sentinel = path.join(tmpdir(), `nc-harness-sentinel-${process.pid}-${Date.now()}`);
    const stray = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');`;
    const dir = lintMetaFixture(PASS_REGISTRY, { 'evil.js': stray });
    const res = runNode(['lint-meta', '--dir', dir]);
    expect(res.status).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    rmSync(sentinel, { force: true });
  });
});

/**
 * The #325 proof: a bundle the Rust exporter WROTE actually reds a foreign CI.
 *
 * Everything under `fixtures/portable-lock/` is emitted by
 * `sidecar/harness/export/writer.rs` and byte-pinned by its tests, so these are the
 * exporter's real bytes, not a hand-written imitation. The target repo declares
 * `"type": "commonjs"` on purpose — the hostile case for ES-module rules, which is why
 * the exporter pins `.mts`.
 */
describe('an exported portable-lock bundle enforces in a foreign repo (#325)', () => {
  const FIXTURES = path.join(PKG_ROOT, 'fixtures', 'portable-lock');
  const BUNDLE_REL = path.join('.nightcore', 'export', 'portable-lock');
  const REGISTRY_REL = path.join(BUNDLE_REL, 'lint-meta', 'registry.mts');
  const MANIFEST_REL = path.join(BUNDLE_REL, 'harness.json');

  /** Stage the exporter's bundle into a fake target repo holding `source` at src/app.ts. */
  function exportedRepo(source: string, opts: { registry?: boolean } = {}): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'nc-harness-export-'));
    fixtures.push(dir);
    // A CommonJS repo: nothing here is ESM by default.
    writeFileSync(path.join(dir, 'package.json'), '{ "name": "target", "type": "commonjs" }', 'utf8');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'app.ts'), source, 'utf8');

    mkdirSync(path.join(dir, BUNDLE_REL, 'lint-meta', 'rules'), { recursive: true });
    writeFileSync(
      path.join(dir, MANIFEST_REL),
      readFileSync(path.join(FIXTURES, 'harness.json.txt'), 'utf8'),
      'utf8',
    );
    if (opts.registry !== false) {
      writeFileSync(
        path.join(dir, REGISTRY_REL),
        readFileSync(path.join(FIXTURES, 'registry.mts.txt'), 'utf8'),
        'utf8',
      );
    }
    writeFileSync(
      path.join(dir, BUNDLE_REL, 'lint-meta', 'rules', 'no-todo-comments.mts'),
      readFileSync(path.join(FIXTURES, 'no-todo-comments.rule.ts.txt'), 'utf8'),
      'utf8',
    );
    return dir;
  }

  const VIOLATING = 'export const x = 1;\n// TODO: finish this\n';
  const CLEAN = 'export const x = 1;\n// finished\n';

  test('a violating repo is CAUGHT: exit 1, naming the rule and the file', () => {
    const dir = exportedRepo(VIOLATING);
    const res = runNode(['lint-meta', '--dir', dir, '--registry', REGISTRY_REL]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[ERROR] no-todo-comments (src/app.ts)');
    // The TypeScript rule really ran (type-stripped) against the real Node ctx.
    expect(res.stdout).toContain('running 1 rule');
  });

  test('the same bundle exits 0 on a clean repo (it is not just always failing)', () => {
    const res = runNode(['lint-meta', '--dir', exportedRepo(CLEAN), '--registry', REGISTRY_REL]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('no violations');
  });

  test('the WHOLE chain reds: check --manifest → spawned lint-meta → violation', () => {
    // The bundle manifest's command is the exporter's, verbatim, except that the npx
    // resolver is swapped for this dist build — `npx @noctcore/harness@<v>` resolves to
    // exactly this artifact, and CI has no registry access here. Every ARGUMENT is the
    // exporter's own.
    const dir = exportedRepo(VIOLATING);
    const manifestPath = path.join(dir, MANIFEST_REL);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      checks: Array<{ command: string }>;
    };
    const exported = manifest.checks[0]?.command ?? '';
    expect(exported).toStartWith('npx --yes @noctcore/harness@');
    expect(exported).toContain(`lint-meta --registry ${REGISTRY_REL}`);
    manifest.checks[0]!.command = exported.replace(
      /^npx --yes @noctcore\/harness@[^ ]+/,
      `node ${CLI}`,
    );
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const res = runNode(['check', '--dir', dir, '--manifest', MANIFEST_REL]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('✗ no-todo-comments');
    expect(res.stderr).toContain('[ERROR] no-todo-comments (src/app.ts)');
  });

  test('a bundle whose registry went missing reds the build, never passes vacuously', () => {
    const dir = exportedRepo(CLEAN, { registry: false });
    const res = runNode(['lint-meta', '--dir', dir, '--registry', REGISTRY_REL]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('No lint-meta registry at');
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
