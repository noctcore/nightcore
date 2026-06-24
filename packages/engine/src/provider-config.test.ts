/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { ProviderConfigReader } from './provider-config.js';
import type { SessionRunner } from './session-runner.js';
import type { Query } from './sdk-adapter.js';

/**
 * Unit-test the `ProviderConfigReader` mapping + per-section tri-state WITHOUT a
 * live SDK. The reader only calls `SessionRunner.withProbe(body, fallback, cwd)`,
 * so a fake runner that invokes `body` with a stubbed `Query` exercises the whole
 * mapping path. The control-method stubs let each test choose what each section
 * returns (or throws), proving sections degrade independently.
 */

/** A partial `Query` carrying only the control methods the reader calls. */
type ProbeStub = Pick<
  Query,
  | 'mcpServerStatus'
  | 'supportedCommands'
  | 'supportedAgents'
  | 'initializationResult'
>;

/** Build a fake `SessionRunner` whose `withProbe` runs `body` against `stub`. When
 *  `openFails` is set, `withProbe` returns the fallback (the open-failed snapshot)
 *  to model a probe subprocess that couldn't start. */
function fakeRunner(stub: ProbeStub, openFails = false): SessionRunner {
  return {
    async withProbe<T>(
      body: (q: Query) => Promise<T>,
      fallback: T,
    ): Promise<T> {
      if (openFails) return fallback;
      return body(stub as Query);
    },
  } as unknown as SessionRunner;
}

/** A reject-once stub method, so a section's read throws. */
function rejecting(): () => Promise<never> {
  return () => Promise.reject(new Error('probe call failed'));
}

const FULL_STUB: ProbeStub = {
  mcpServerStatus: () =>
    Promise.resolve([
      {
        name: 'github',
        status: 'connected',
        scope: 'project',
        config: { type: 'http', url: 'https://x' },
        tools: [{ name: 'a' }, { name: 'b' }],
      },
      // A command-based stdio server: no `type`, but a `command` ⇒ inferred stdio.
      { name: 'local', status: 'pending', config: { command: 'node' } },
    ] as unknown as Awaited<ReturnType<Query['mcpServerStatus']>>),
  supportedCommands: () =>
    Promise.resolve([
      { name: 'add-feature', description: 'ship a feature', argumentHint: '' },
    ] as unknown as Awaited<ReturnType<Query['supportedCommands']>>),
  supportedAgents: () =>
    Promise.resolve([
      { name: 'Explore', description: 'read-only search', model: 'haiku' },
    ] as unknown as Awaited<ReturnType<Query['supportedAgents']>>),
  initializationResult: () =>
    Promise.resolve({
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: ['default'],
      models: [{ value: 'claude-opus-4-8', displayName: 'Opus' }],
      account: {},
    } as unknown as Awaited<ReturnType<Query['initializationResult']>>),
};

describe('ProviderConfigReader — supported sections', () => {
  test('maps every section to supported with resolved data', async () => {
    const snapshot = await new ProviderConfigReader().read(
      fakeRunner(FULL_STUB),
      '/proj',
    );

    expect(snapshot.providerId).toBe('claude');
    expect(snapshot.providerLabel).toBe('Claude');
    expect(snapshot.projectPath).toBe('/proj');

    expect(snapshot.mcp.status).toBe('supported');
    expect(snapshot.mcp.mcpServers).toEqual([
      {
        name: 'github',
        status: 'connected',
        scope: 'project',
        transport: 'http',
        toolCount: 2,
      },
      { name: 'local', status: 'pending', transport: 'stdio' },
    ]);

    expect(snapshot.skills.status).toBe('supported');
    expect(snapshot.skills.skills).toEqual([
      { name: 'add-feature', description: 'ship a feature' },
    ]);

    expect(snapshot.subagents.status).toBe('supported');
    expect(snapshot.subagents.subagents).toEqual([
      { name: 'Explore', description: 'read-only search', model: 'haiku' },
    ]);

    expect(snapshot.extrasStatus).toBe('supported');
    expect(snapshot.model).toBe('claude-opus-4-8');
    expect(snapshot.outputStyle).toBe('default');
  });

  test('an empty-but-successful skills read is supported with [], not unsupported', async () => {
    // Strict isolation legitimately yields no skills — that is `supported` + [].
    const snapshot = await new ProviderConfigReader().read(
      fakeRunner({ ...FULL_STUB, supportedCommands: () => Promise.resolve([]) }),
      '/proj',
    );
    expect(snapshot.skills.status).toBe('supported');
    expect(snapshot.skills.skills).toEqual([]);
  });
});

describe('ProviderConfigReader — per-section independence', () => {
  test('one failing section is unavailable while the rest stay supported', async () => {
    const snapshot = await new ProviderConfigReader().read(
      fakeRunner({ ...FULL_STUB, mcpServerStatus: rejecting() }),
      '/proj',
    );

    expect(snapshot.mcp.status).toBe('unavailable');
    expect(snapshot.mcp.error).toContain('probe call failed');
    expect(snapshot.mcp.mcpServers).toBeUndefined();

    // The other sections are unaffected by the MCP failure.
    expect(snapshot.skills.status).toBe('supported');
    expect(snapshot.subagents.status).toBe('supported');
    expect(snapshot.extrasStatus).toBe('supported');
  });

  test('a failing extras read degrades only the extras group', async () => {
    const snapshot = await new ProviderConfigReader().read(
      fakeRunner({ ...FULL_STUB, initializationResult: rejecting() }),
      '/proj',
    );
    expect(snapshot.extrasStatus).toBe('unavailable');
    expect(snapshot.model).toBeUndefined();
    expect(snapshot.skills.status).toBe('supported');
  });
});

describe('ProviderConfigReader — probe could not start', () => {
  test('every section is unavailable when the probe subprocess cannot open', async () => {
    const snapshot = await new ProviderConfigReader().read(
      fakeRunner(FULL_STUB, true),
      '/proj',
    );
    for (const section of [
      snapshot.mcp,
      snapshot.skills,
      snapshot.subagents,
    ]) {
      expect(section.status).toBe('unavailable');
      expect(section.error).toContain('could not be started');
    }
    expect(snapshot.extrasStatus).toBe('unavailable');
    expect(snapshot.projectPath).toBe('/proj');
  });
});
