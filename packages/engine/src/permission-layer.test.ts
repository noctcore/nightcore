/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { PermissionPolicy, ToolRisk } from '@nightcore/contracts';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  PermissionLayer,
  type PermissionPromptRequest,
  type RiskLookup,
} from './permission-layer.js';

const EXEC = 'mcp__nightcore__run_command';
const READ = 'mcp__nightcore__read_file';

const riskMap: Record<string, ToolRisk> = {
  [EXEC]: 'dangerous',
  [READ]: 'safe',
};
const riskOf: RiskLookup = (name) => riskMap[name];

/** Drive `canUseTool` once. Emitted prompts land in the layer's onPrompt sink. */
function invoke(
  layer: PermissionLayer,
  toolName: string,
): Promise<PermissionResult> {
  const controller = new AbortController();
  return layer.canUseTool(
    toolName,
    {},
    { signal: controller.signal } as Parameters<typeof layer.canUseTool>[2],
  );
}

function makeLayer(
  policy: PermissionPolicy,
  risk: RiskLookup = riskOf,
): { layer: PermissionLayer; prompts: PermissionPromptRequest[] } {
  const prompts: PermissionPromptRequest[] = [];
  const layer = new PermissionLayer(policy, (req) => prompts.push(req), risk);
  return { layer, prompts };
}

describe('PermissionLayer risk gating', () => {
  test('a dangerous tool NOT in the allow list always prompts, even when allow is broad', () => {
    const policy: PermissionPolicy = {
      // Broad allow that happens to omit the dangerous tool.
      allow: [READ, 'mcp__nightcore__write_file'],
      deny: [],
      mode: 'acceptEdits',
    };
    const { layer, prompts } = makeLayer(policy);

    void invoke(layer, EXEC);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.toolName).toBe(EXEC);
    expect(prompts[0]?.risk).toBe('dangerous');
  });

  test('a dangerous tool explicitly allow-listed is auto-allowed', async () => {
    const policy: PermissionPolicy = { allow: [EXEC], deny: [], mode: 'default' };
    const { layer, prompts } = makeLayer(policy);

    const result = await invoke(layer, EXEC);

    expect(result.behavior).toBe('allow');
    expect(prompts).toHaveLength(0);
  });

  test('an unknown-risk tool (no descriptor) prompts unless allow-listed', () => {
    const policy: PermissionPolicy = { allow: [], deny: [], mode: 'default' };
    const { layer, prompts } = makeLayer(policy, () => undefined);

    void invoke(layer, 'mcp__external__mystery');

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.risk).toBeUndefined();
  });

  test('a safe tool in the allow list is auto-allowed without prompting', async () => {
    const policy: PermissionPolicy = { allow: [READ], deny: [], mode: 'default' };
    const { layer, prompts } = makeLayer(policy);

    const result = await invoke(layer, READ);

    expect(result.behavior).toBe('allow');
    expect(prompts).toHaveLength(0);
  });

  test('the deny list wins over everything, including allow', async () => {
    const policy: PermissionPolicy = {
      allow: [EXEC],
      deny: [EXEC],
      mode: 'default',
    };
    const { layer, prompts } = makeLayer(policy);

    const result = await invoke(layer, EXEC);

    expect(result.behavior).toBe('deny');
    expect(prompts).toHaveLength(0);
  });
});

describe('PermissionLayer interactive resolve', () => {
  test('approving without updatedInput echoes the original input', async () => {
    // Regression: the SDK rejects an allow result that omits `updatedInput`
    // (ZodError invalid_union), which surfaced as an "ExitPlanMode internal
    // error". A bare allow from the surface must echo the original input.
    const policy: PermissionPolicy = { allow: [], deny: [], mode: 'default' };
    const { layer, prompts } = makeLayer(policy);
    const input = { plan: 'create hello.txt', allowedPrompts: [] };

    const controller = new AbortController();
    const pending = layer.canUseTool(
      'ExitPlanMode',
      input,
      { signal: controller.signal } as Parameters<typeof layer.canUseTool>[2],
    );

    expect(prompts).toHaveLength(1);
    const requestId = prompts[0]?.requestId ?? '';
    expect(layer.resolve(requestId, { behavior: 'allow' })).toBe(true);

    const result = await pending;
    expect(result.behavior).toBe('allow');
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: input });
  });

  test('a surface-supplied updatedInput overrides the original', async () => {
    const policy: PermissionPolicy = { allow: [], deny: [], mode: 'default' };
    const { layer, prompts } = makeLayer(policy);

    const controller = new AbortController();
    const pending = layer.canUseTool(
      'ExitPlanMode',
      { plan: 'a' },
      { signal: controller.signal } as Parameters<typeof layer.canUseTool>[2],
    );
    const requestId = prompts[0]?.requestId ?? '';
    layer.resolve(requestId, { behavior: 'allow', updatedInput: { plan: 'b' } });

    const result = await pending;
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { plan: 'b' } });
  });
});
