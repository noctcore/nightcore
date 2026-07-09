/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import { toModelDescriptor } from './mappers.js';

describe('toModelDescriptor', () => {
  test('maps a fully-populated ModelInfo straight across', () => {
    const info: ModelInfo = {
      value: 'claude-opus-4-8',
      displayName: 'Opus 4.8',
      description: 'Most capable model.',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high', 'max'],
    };

    expect(toModelDescriptor(info)).toEqual({
      value: 'claude-opus-4-8',
      displayName: 'Opus 4.8',
      description: 'Most capable model.',
      providerId: 'claude',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high', 'max'],
    });
  });

  test('defaults absent effort fields to the conservative values', () => {
    const info: ModelInfo = {
      value: 'claude-haiku-4-5',
      displayName: 'Haiku 4.5',
      description: 'Fast and cheap.',
    };

    const descriptor = toModelDescriptor(info);
    expect(descriptor.supportsEffort).toBe(false);
    expect(descriptor.supportedEffortLevels).toEqual([]);
  });
});
