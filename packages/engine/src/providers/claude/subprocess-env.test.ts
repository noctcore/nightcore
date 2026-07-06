/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { buildSubprocessEnv, isAllowedEnvVar } from './subprocess-env.js';

describe('isAllowedEnvVar', () => {
  test('allows system/runtime essentials', () => {
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'HTTPS_PROXY']) {
      expect(isAllowedEnvVar(name)).toBe(true);
    }
  });

  test('allows the agent’s own Anthropic/Claude vars by prefix', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_ENABLE_TASKS',
      'LC_ALL',
      'XDG_CONFIG_HOME',
      'BUN_CONFIG_REGISTRY',
    ]) {
      expect(isAllowedEnvVar(name)).toBe(true);
    }
  });

  test('is case-insensitive (lowercase proxy vars match)', () => {
    expect(isAllowedEnvVar('http_proxy')).toBe(true);
    expect(isAllowedEnvVar('no_proxy')).toBe(true);
  });

  test('drops unrelated secrets', () => {
    for (const name of [
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'GITHUB_TOKEN',
      'DATABASE_URL',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'STRIPE_SECRET_KEY',
      'NPM_TOKEN',
    ]) {
      expect(isAllowedEnvVar(name)).toBe(false);
    }
  });
});

describe('buildSubprocessEnv', () => {
  test('keeps allowlisted vars and drops the rest', () => {
    const env = buildSubprocessEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      AWS_SECRET_ACCESS_KEY: 'leak-me',
      GITHUB_TOKEN: 'ghp_leak',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test('overrides are applied last and win even if filtered from parent', () => {
    const env = buildSubprocessEnv(
      { PATH: '/usr/bin', SECRET: 'nope' },
      { CLAUDE_CODE_ENABLE_TASKS: '1' },
    );
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('1');
    expect(env.SECRET).toBeUndefined();
  });

  test('override replaces an allowlisted parent value', () => {
    const env = buildSubprocessEnv(
      { CLAUDE_CODE_ENABLE_TASKS: '0' },
      { CLAUDE_CODE_ENABLE_TASKS: '1' },
    );
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('1');
  });

  test('skips undefined parent values', () => {
    const env = buildSubprocessEnv({ PATH: undefined, HOME: '/h' });
    expect('PATH' in env).toBe(false);
    expect(env.HOME).toBe('/h');
  });
});
