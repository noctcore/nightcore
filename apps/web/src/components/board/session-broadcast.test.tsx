import { describe, expect, test, vi } from 'vitest';

import { broadcastInput, resolveSessionBroadcastTargets } from './session-broadcast';

describe('resolveSessionBroadcastTargets (session fan-out targeting)', () => {
  test('disarmed → the origin alone, ignoring the live set', () => {
    expect(resolveSessionBroadcastTargets('a', false, ['a', 'b', 'c'])).toEqual(['a']);
  });

  test('armed → every live session, the origin included', () => {
    expect(new Set(resolveSessionBroadcastTargets('a', true, ['a', 'b', 'c']))).toEqual(
      new Set(['a', 'b', 'c']),
    );
  });

  test('armed but no live sessions → the origin alone (never an empty send)', () => {
    expect(resolveSessionBroadcastTargets('a', true, [])).toEqual(['a']);
  });

  test('armed always keeps the self-send even if the origin is absent from live', () => {
    expect(new Set(resolveSessionBroadcastTargets('a', true, ['b', 'c']))).toEqual(
      new Set(['a', 'b', 'c']),
    );
  });

  test('dedupes so the origin is never sent to twice', () => {
    const targets = resolveSessionBroadcastTargets('a', true, ['a', 'b']);
    expect(targets).toHaveLength(2);
    expect(new Set(targets)).toEqual(new Set(['a', 'b']));
  });
});

describe('broadcastInput (fan-out writer)', () => {
  test('disarmed sends only to the origin', () => {
    const send = vi.fn();
    const targets = broadcastInput('a', 'hi', false, ['a', 'b', 'c'], send);
    expect(targets).toEqual(['a']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('a', 'hi');
  });

  test('armed sends the same text to every live session', () => {
    const send = vi.fn();
    const targets = broadcastInput('a', 'stop', true, ['a', 'b', 'c'], send);
    expect(new Set(targets)).toEqual(new Set(['a', 'b', 'c']));
    expect(send).toHaveBeenCalledTimes(3);
    for (const call of send.mock.calls) expect(call[1]).toBe('stop');
  });
});
