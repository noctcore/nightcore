/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { ConfigFile } from '@nightcore/contracts';

import { mergeLayers, resolveConfig } from './index.js';

let tmp: string;
let home: string;
let project: string;

/** The home dir IS the `.nightcore` dir, so its config.json sits directly under
 *  it. A project's config.json lives under `<cwd>/.nightcore/`. */
function writeHomeConfig(contents: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), contents, 'utf8');
}

function writeProjectConfig(cwd: string, contents: string): void {
  const nc = path.join(cwd, '.nightcore');
  fs.mkdirSync(nc, { recursive: true });
  fs.writeFileSync(path.join(nc, 'config.json'), contents, 'utf8');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcore-config-'));
  home = path.join(tmp, 'home');
  project = path.join(tmp, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveConfig precedence', () => {
  test('falls back to defaults when no config files exist', () => {
    const config = resolveConfig({ home, cwd: project });
    expect(config.model).toBe('claude-opus-4-8');
    expect(config.logLevel).toBe('info');
    expect(config.permissions).toEqual({ allow: [], deny: [], mode: 'default' });
    expect(config.paths.home).toBe(home);
    expect(config.paths.project).toBeUndefined();
    expect(config.paths.sessions).toBe(path.join(home, 'sessions'));
  });

  test('applies the user (home) layer over defaults', () => {
    writeHomeConfig(JSON.stringify({ model: 'claude-sonnet-4-6' }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.model).toBe('claude-sonnet-4-6');
  });

  test('project layer overrides the home layer', () => {
    writeHomeConfig(JSON.stringify({ model: 'claude-sonnet-4-6' }));
    writeProjectConfig(project, JSON.stringify({ model: 'claude-haiku-4-5' }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.model).toBe('claude-haiku-4-5');
    expect(config.paths.project).toBe(path.join(project, '.nightcore'));
  });

  test('a project layer overrides the permission mode', () => {
    writeHomeConfig(
      JSON.stringify({ permissions: { allow: ['Read'], mode: 'default' } }),
    );
    writeProjectConfig(project, JSON.stringify({ permissions: { mode: 'acceptEdits' } }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.permissions.mode).toBe('acceptEdits');
  });

  test('carries effort across layers (home sets it, project inherits)', () => {
    writeHomeConfig(JSON.stringify({ effort: 'high' }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.effort).toBe('high');
  });

  test('a project layer overrides the inherited effort', () => {
    writeHomeConfig(JSON.stringify({ effort: 'high' }));
    writeProjectConfig(project, JSON.stringify({ effort: 'low' }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.effort).toBe('low');
  });

  test('carries settingSources across layers (home sets it, project inherits)', () => {
    writeHomeConfig(JSON.stringify({ settingSources: ['project'] }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.settingSources).toEqual(['project']);
  });

  test('a project layer overrides the inherited settingSources', () => {
    writeHomeConfig(JSON.stringify({ settingSources: ['user', 'project'] }));
    writeProjectConfig(project, JSON.stringify({ settingSources: [] }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.settingSources).toEqual([]);
  });

  test('carries todoFeatureEnabled across layers (home disables, project inherits)', () => {
    writeHomeConfig(JSON.stringify({ todoFeatureEnabled: false }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.todoFeatureEnabled).toBe(false);
  });

  test('a project layer overrides the inherited todoFeatureEnabled', () => {
    writeHomeConfig(JSON.stringify({ todoFeatureEnabled: false }));
    writeProjectConfig(project, JSON.stringify({ todoFeatureEnabled: true }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.todoFeatureEnabled).toBe(true);
  });

  // A project layer overriding `mode` must inherit the home allow/deny lists.
  // Guaranteed by the default-free `ConfigFileSchema` + explicit nested merge in
  // `mergeLayers` (an absent key stays absent, so it can't clobber).
  test('merges permissions one level deep (inherits home allow-list)', () => {
    writeHomeConfig(
      JSON.stringify({ permissions: { allow: ['Read'], mode: 'default' } }),
    );
    writeProjectConfig(project, JSON.stringify({ permissions: { mode: 'acceptEdits' } }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.permissions.mode).toBe('acceptEdits');
    expect(config.permissions.allow).toEqual(['Read']);
  });
});

// The agent provider (issue #18): file-configurable, env-overridable, defaults to
// Claude. The Rust core injects its studio-wide `provider` setting via the
// `NIGHTCORE_PROVIDER` env override so a provider swap needs no config-file edit.
describe('resolveConfig provider selection', () => {
  const ENV_KEY = 'NIGHTCORE_PROVIDER';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  test('defaults to claude when nothing sets it', () => {
    expect(resolveConfig({ home, cwd: project }).provider).toBe('claude');
  });

  test('a config file selects the provider', () => {
    writeHomeConfig(JSON.stringify({ provider: 'codex' }));
    expect(resolveConfig({ home, cwd: project }).provider).toBe('codex');
  });

  test('the NIGHTCORE_PROVIDER env override wins over the config file', () => {
    writeHomeConfig(JSON.stringify({ provider: 'claude' }));
    process.env[ENV_KEY] = 'codex';
    expect(resolveConfig({ home, cwd: project }).provider).toBe('codex');
  });

  test('an empty/whitespace env override is ignored (inherits the file/default)', () => {
    process.env[ENV_KEY] = '   ';
    expect(resolveConfig({ home, cwd: project }).provider).toBe('claude');
  });
});

describe('mergeLayers is key-driven, not hand-enumerated', () => {
  // Guards the regression class this refactor closed: a NEW field added to
  // `ConfigFileSchema` must layer (last-defined-wins, absent-inherits) with no
  // edit to `mergeLayers`. We simulate a not-yet-enumerated field to prove the
  // merge copies whatever keys a layer carries — the old per-field enumeration
  // silently dropped any field it didn't name.
  test('a field mergeLayers does not name still layers (last-defined-wins)', () => {
    const user: ConfigFile & Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
      futureField: 'from-user',
    };
    const project: ConfigFile & Record<string, unknown> = {
      futureField: 'from-project',
    };
    const merged = mergeLayers(user, project) as Record<string, unknown>;
    expect(merged.model).toBe('claude-sonnet-4-6'); // inherited from user
    expect(merged.futureField).toBe('from-project'); // project overrides user
  });

  test('an absent field inherits rather than clobbers, across the spread', () => {
    const user: ConfigFile = { model: 'claude-sonnet-4-6', maxTurns: 42 };
    const project: ConfigFile = { model: 'claude-haiku-4-5' };
    const merged = mergeLayers(user, project);
    expect(merged.model).toBe('claude-haiku-4-5'); // project wins
    expect(merged.maxTurns).toBe(42); // inherited (project omitted it)
  });

  test('permissions still merge one level deep despite the shallow spread', () => {
    const user: ConfigFile = {
      permissions: { allow: ['Read'], mode: 'default' },
    };
    const project: ConfigFile = { permissions: { mode: 'acceptEdits' } };
    const merged = mergeLayers(user, project);
    expect(merged.permissions).toEqual({ allow: ['Read'], mode: 'acceptEdits' });
  });
});

describe('resolveConfig degrades, does not throw', () => {
  test('ignores a malformed (non-JSON) config file', () => {
    writeProjectConfig(project, '{ this is not json');
    const config = resolveConfig({ home, cwd: project });
    expect(config.model).toBe('claude-opus-4-8');
  });

  test('ignores a structurally invalid config file', () => {
    writeProjectConfig(project, JSON.stringify({ logLevel: 'screaming' }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.logLevel).toBe('info');
  });

  test('a malformed home layer still lets the project layer through', () => {
    writeHomeConfig('garbage{');
    writeProjectConfig(project, JSON.stringify({ model: 'claude-haiku-4-5' }));
    const config = resolveConfig({ home, cwd: project });
    expect(config.model).toBe('claude-haiku-4-5');
  });
});
