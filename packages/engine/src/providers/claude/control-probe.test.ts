/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { ControlProbe } from './control-probe.js';
import type { Options, Query } from './sdk-adapter.js';

/**
 * A fake SDK `Query` exposing only the control reads the probe surface calls, each
 * recording that it was hit so a test can assert dispatch. No transient subprocess
 * is ever spawned on the live-query REUSE path, so these tests need no SDK mock.
 */
function fakeQuery(): { query: Query; calls: string[] } {
  const calls: string[] = [];
  const record =
    <T>(name: string, value: T) =>
    async (): Promise<T> => {
      calls.push(name);
      return value;
    };
  const query = {
    supportedModels: record('supportedModels', [{ value: 'opus' }]),
    mcpServerStatus: record('mcpServerStatus', [{ name: 'srv' }]),
    supportedCommands: record('supportedCommands', [{ name: '/do' }]),
    supportedAgents: record('supportedAgents', [{ name: 'agent' }]),
    initializationResult: record('initializationResult', { model: 'opus' }),
  } as unknown as Query;
  return { query, calls };
}

const optionsBase = (): Options => ({}) as Options;

describe('ControlProbe — live-query reuse surface', () => {
  test('reuses the live query (no cwd override) and returns each typed read', async () => {
    const { query, calls } = fakeQuery();
    const probe = new ControlProbe(() => query, optionsBase);

    expect(await probe.supportedModels()).toEqual([{ value: 'opus' }]);
    expect(await probe.mcpServerStatus()).toEqual([{ name: 'srv' }]);
    expect(await probe.supportedCommands()).toEqual([{ name: '/do' }]);
    expect(await probe.supportedAgents()).toEqual([{ name: 'agent' }]);
    expect(await probe.initializationResult()).toEqual({ model: 'opus' });

    // Every read dispatched to the reused query's matching control method.
    expect(calls).toEqual([
      'supportedModels',
      'mcpServerStatus',
      'supportedCommands',
      'supportedAgents',
      'initializationResult',
    ]);
  });

  test('control() runs an arbitrary call against the reused query', async () => {
    const { query } = fakeQuery();
    const probe = new ControlProbe(() => query, optionsBase);

    const models = await probe.control((q) => q.supportedModels(), []);
    expect(models).toEqual([{ value: 'opus' }]);
  });

  test('withProbe hands the reused query to the caller body', async () => {
    const { query } = fakeQuery();
    const probe = new ControlProbe(() => query, optionsBase);

    const received = await probe.withProbe(
      async (q) => {
        const [mcp, skills] = await Promise.all([
          q.mcpServerStatus(),
          q.supportedCommands(),
        ]);
        return { mcp, skills };
      },
      { mcp: [], skills: [] },
    );

    expect(received).toEqual({ mcp: [{ name: 'srv' }], skills: [{ name: '/do' }] });
  });
});
