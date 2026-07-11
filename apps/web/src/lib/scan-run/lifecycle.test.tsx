import { describe, expect, it } from 'vitest';

import { isUsageLimitSignature } from './lifecycle';

describe('isUsageLimitSignature', () => {
  it('fires on a completed run that spent $0 with zero input tokens', () => {
    expect(
      isUsageLimitSignature({ status: 'completed', costUsd: 0, inputTokens: 0 }),
    ).toBe(true);
  });

  it('does not fire when the run consumed input tokens', () => {
    expect(
      isUsageLimitSignature({ status: 'completed', costUsd: 0, inputTokens: 12_000 }),
    ).toBe(false);
  });

  it('does not fire when the run recorded a cost', () => {
    expect(
      isUsageLimitSignature({ status: 'completed', costUsd: 0.42, inputTokens: 0 }),
    ).toBe(false);
  });

  it('only fires on a completed run (never running / failed / idle)', () => {
    for (const status of ['running', 'failed', 'idle'] as const) {
      expect(isUsageLimitSignature({ status, costUsd: 0, inputTokens: 0 })).toBe(false);
    }
  });
});
