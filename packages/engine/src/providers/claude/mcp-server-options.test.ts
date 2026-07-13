/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { McpServerEntry } from '@nightcore/contracts';

import { toSdkMcpServers } from './mcp-server-options.js';

describe('toSdkMcpServers — contract → SDK Options.mcpServers', () => {
  const stdio = (
    id: string,
    name: string,
    enabled: boolean,
    extra: Partial<{ args: string[]; env: Record<string, string> }> = {},
  ): McpServerEntry => ({
    id,
    name,
    enabled,
    config: {
      transport: 'stdio',
      command: 'npx',
      args: extra.args ?? [],
      env: extra.env ?? {},
    },
  });

  test('an absent or empty list yields undefined (the key is omitted)', () => {
    // Byte-identical to the pre-feature options: no `mcpServers` key at all.
    expect(toSdkMcpServers(undefined)).toBeUndefined();
    expect(toSdkMcpServers([])).toBeUndefined();
  });

  test('a list of only-disabled entries yields undefined', () => {
    expect(toSdkMcpServers([stdio('a', 'alpha', false)])).toBeUndefined();
  });

  test('disabled entries are dropped; the name becomes the record key', () => {
    const servers = toSdkMcpServers([
      stdio('a', 'alpha', true, { args: ['-y', 'pkg'], env: { ROOT: '/x' } }),
      stdio('b', 'bravo', false),
      stdio('c', 'charlie', true),
    ]);
    expect(servers).toBeDefined();
    expect(Object.keys(servers ?? {}).sort()).toEqual(['alpha', 'charlie']);
  });

  test('stdio OMITS `type` and only sets env when non-empty', () => {
    const servers = toSdkMcpServers([
      stdio('a', 'with-env', true, { args: ['-y', 'pkg'], env: { K: 'v' } }),
      stdio('b', 'no-env', true),
    ]);
    const withEnv = servers?.['with-env'];
    const noEnv = servers?.['no-env'];
    // stdio config has no `type` key (the SDK defaults `type?: 'stdio'`).
    expect(withEnv).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } });
    expect(withEnv && 'type' in withEnv).toBe(false);
    // An empty env map is omitted entirely.
    expect(noEnv).toEqual({ command: 'npx', args: [] });
    expect(noEnv && 'env' in noEnv).toBe(false);
  });

  test('http SETS type=http and only sets headers when non-empty', () => {
    const servers = toSdkMcpServers([
      {
        id: 'h1',
        name: 'github',
        enabled: true,
        config: {
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer t' },
        },
      },
      {
        id: 'h2',
        name: 'plain',
        enabled: true,
        config: { transport: 'http', url: 'https://example.com/x', headers: {} },
      },
    ]);
    expect(servers?.['github']).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
    });
    const plain = servers?.['plain'];
    expect(plain).toEqual({ type: 'http', url: 'https://example.com/x' });
    expect(plain && 'headers' in plain).toBe(false);
  });

  test('sse SETS type=sse', () => {
    const servers = toSdkMcpServers([
      {
        id: 's1',
        name: 'legacy',
        enabled: true,
        config: {
          transport: 'sse',
          url: 'https://example.com/sse',
          headers: { 'X-Key': 'abc' },
        },
      },
    ]);
    expect(servers?.['legacy']).toEqual({
      type: 'sse',
      url: 'https://example.com/sse',
      headers: { 'X-Key': 'abc' },
    });
  });

  test('a later duplicate name wins (last write to the record key)', () => {
    const servers = toSdkMcpServers([
      stdio('a', 'dup', true, { args: ['first'] }),
      stdio('b', 'dup', true, { args: ['second'] }),
    ]);
    expect(Object.keys(servers ?? {})).toEqual(['dup']);
    expect(servers?.['dup']).toEqual({ command: 'npx', args: ['second'] });
  });
});
