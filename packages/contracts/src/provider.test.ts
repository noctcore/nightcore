/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  AutonomyLevelSchema,
  CostTelemetrySchema,
  ProviderCapabilitiesSchema,
  ProviderIdSchema,
} from './provider.js';

describe('ProviderIdSchema', () => {
  test('accepts lowercase provider slugs', () => {
    for (const id of ['claude', 'codex', 'gemini', 'a', 'gpt-5', 'x1-y2']) {
      expect(ProviderIdSchema.safeParse(id).success).toBe(true);
    }
  });

  test('rejects ids with uppercase, spaces, leading digits, or empty', () => {
    for (const id of ['Claude', 'my provider', 'my.provider', '1codex', '', '-x']) {
      expect(ProviderIdSchema.safeParse(id).success).toBe(false);
    }
  });
});

describe('AutonomyLevelSchema', () => {
  test('accepts the four settings-layer levels', () => {
    for (const level of ['bypass', 'auto-accept', 'ask', 'plan']) {
      expect(AutonomyLevelSchema.safeParse(level).success).toBe(true);
    }
  });

  test('rejects an SDK permission-mode string (Claude-internal, not the contract)', () => {
    for (const level of ['bypassPermissions', 'acceptEdits', 'default', 'yolo']) {
      expect(AutonomyLevelSchema.safeParse(level).success).toBe(false);
    }
  });
});

describe('CostTelemetrySchema', () => {
  test('accepts the three telemetry tiers', () => {
    for (const tier of ['full', 'tokens-only', 'none']) {
      expect(CostTelemetrySchema.safeParse(tier).success).toBe(true);
    }
  });

  test('rejects an unknown tier', () => {
    expect(CostTelemetrySchema.safeParse('partial').success).toBe(false);
  });
});

describe('ProviderCapabilitiesSchema', () => {
  const claude = {
    id: 'claude',
    label: 'Claude',
    autonomyLevels: ['bypass', 'auto-accept', 'ask', 'plan'],
    supportsHooks: true,
    providesOwnWriteContainment: false,
    supportsMcp: true,
    supportsPlanMode: true,
    supportsStructuredOutput: true,
    supportsSessionResume: true,
    supportsFileCheckpointing: true,
    supportsAskUserQuestion: true,
    supportsSettingSources: true,
    supportsSessionStore: true,
    supportsEffort: true,
    costTelemetry: 'full',
  };

  test('parses the Claude descriptor and preserves every field', () => {
    const parsed = ProviderCapabilitiesSchema.parse(claude);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(claude).sort());
    expect(parsed.id).toBe('claude');
    expect(parsed.autonomyLevels).toEqual([
      'bypass',
      'auto-accept',
      'ask',
      'plan',
    ]);
    expect(parsed.costTelemetry).toBe('full');
    expect(parsed.providesOwnWriteContainment).toBe(false);
  });

  test('parses a degraded provider with absent containment default', () => {
    const withoutContainment: Record<string, unknown> = {
      ...claude,
      id: 'stub',
      label: 'Stub',
      autonomyLevels: ['ask'],
      supportsHooks: false,
      supportsStructuredOutput: false,
      supportsAskUserQuestion: false,
      costTelemetry: 'none',
    };
    delete withoutContainment.providesOwnWriteContainment;
    const parsed = ProviderCapabilitiesSchema.parse(withoutContainment);
    expect(parsed.providesOwnWriteContainment).toBe(false);
  });

  test('parses a provider with native write containment and token-only cost', () => {
    const parsed = ProviderCapabilitiesSchema.parse({
      ...claude,
      id: 'codex',
      label: 'Codex',
      autonomyLevels: ['auto-accept', 'ask', 'plan'],
      supportsHooks: false,
      providesOwnWriteContainment: true,
      supportsAskUserQuestion: false,
      costTelemetry: 'tokens-only',
    });
    expect(parsed.supportsHooks).toBe(false);
    expect(parsed.providesOwnWriteContainment).toBe(true);
    expect(parsed.autonomyLevels).toEqual(['auto-accept', 'ask', 'plan']);
    expect(parsed.costTelemetry).toBe('tokens-only');
  });

  test('every capability flag is required (no implicit false)', () => {
    const missingHooks: Record<string, unknown> = { ...claude };
    delete missingHooks.supportsHooks;
    expect(ProviderCapabilitiesSchema.safeParse(missingHooks).success).toBe(
      false,
    );
  });

  test('rejects an invalid provider id', () => {
    expect(
      ProviderCapabilitiesSchema.safeParse({ ...claude, id: 'Claude Agent' })
        .success,
    ).toBe(false);
  });

  test('rejects an unknown autonomy level in the list', () => {
    expect(
      ProviderCapabilitiesSchema.safeParse({
        ...claude,
        autonomyLevels: ['bypass', 'acceptEdits'],
      }).success,
    ).toBe(false);
  });

  test('rejects an unknown cost-telemetry tier', () => {
    expect(
      ProviderCapabilitiesSchema.safeParse({ ...claude, costTelemetry: 'some' })
        .success,
    ).toBe(false);
  });
});
