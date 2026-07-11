import { describe, expect, it } from 'vitest';

import { canRunTask } from './run-gating';

describe('canRunTask', () => {
  it('enables a run when a slot is free and the task is not blocked', () => {
    expect(canRunTask({ blocked: false, slotsFree: true })).toEqual({
      enabled: true,
      reason: null,
    });
  });

  it('disables a blocked task with a dependency reason (before the slot check)', () => {
    // Blocked wins even when a slot is free.
    const gate = canRunTask({ blocked: true, slotsFree: true });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toMatch(/dependency/i);
  });

  it('disables when no run slot is free at the configured concurrency', () => {
    const gate = canRunTask({ blocked: false, slotsFree: false });
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toMatch(/run slots are busy/);
  });
});
