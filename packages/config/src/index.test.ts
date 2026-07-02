/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { resolveConfig } from './index.js';

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
