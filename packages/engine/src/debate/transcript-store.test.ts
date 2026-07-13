/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { DebateEntryInput } from './transcript-store.js';
import { DebateTranscriptStore } from './transcript-store.js';

function message(content: string): DebateEntryInput {
  return {
    stage: 'debate',
    seatId: 'seat-a',
    role: 'proposer',
    kind: 'message',
    content,
  };
}

describe('DebateTranscriptStore (safety #7: append-only + ordered replay)', () => {
  test('append assigns a 0-based monotonic seq per run and a clock timestamp', () => {
    let clock = 100;
    const store = new DebateTranscriptStore(() => clock);

    const first = store.append('run-1', message('one'));
    clock = 200;
    const second = store.append('run-1', message('two'));

    expect(first.seq).toBe(0);
    expect(first.at).toBe(100);
    expect(second.seq).toBe(1);
    expect(second.at).toBe(200);
    expect(store.size('run-1')).toBe(2);
  });

  test('seq is scoped per council run', () => {
    const store = new DebateTranscriptStore(() => 0);
    store.append('run-1', message('a'));
    const otherRunFirst = store.append('run-2', message('b'));
    expect(otherRunFirst.seq).toBe(0);
    expect(store.runIds().slice().sort()).toEqual(['run-1', 'run-2']);
  });

  test('an ordered read reconstructs the exact append sequence (replay)', () => {
    const store = new DebateTranscriptStore(() => 0);
    for (const c of ['a', 'b', 'c', 'd']) store.append('run-1', message(c));

    const replay = store.read('run-1');
    expect(replay.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(replay.map((e) => e.content)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('an unknown run reads as an empty list', () => {
    const store = new DebateTranscriptStore(() => 0);
    expect(store.read('nope')).toEqual([]);
    expect(store.size('nope')).toBe(0);
  });

  test('stored entries are immutable -- a mutation attempt throws and the record stands', () => {
    const store = new DebateTranscriptStore(() => 0);
    const entry = store.append('run-1', message('original'));

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      // @ts-expect-error -- intentionally attempting a forbidden mutation
      entry.content = 'tampered';
    }).toThrow();
    expect(store.read('run-1')[0]?.content).toBe('original');
  });

  test("a delivery entry's injectionFlags array is frozen too", () => {
    const store = new DebateTranscriptStore(() => 0);
    const entry = store.append('run-1', {
      stage: 'debate',
      seatId: 'seat-a',
      role: 'proposer',
      kind: 'delivery',
      content: 'quoted...',
      injectionFlags: ['some-reason'],
    });
    expect(Object.isFrozen(entry.injectionFlags)).toBe(true);
    expect(() => {
      entry.injectionFlags?.push('injected-after-the-fact');
    }).toThrow();
  });

  test('a read snapshot cannot be pushed back into the live transcript', () => {
    const store = new DebateTranscriptStore(() => 0);
    store.append('run-1', message('a'));
    const snapshot = store.read('run-1');
    expect(() => {
      (snapshot as unknown as unknown[]).push({});
    }).toThrow();
    expect(store.size('run-1')).toBe(1);
  });

  test('the public surface exposes NO mutate/delete path (append-only by shape)', () => {
    const store = new DebateTranscriptStore(() => 0);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    expect(methods.sort()).toEqual(
      ['append', 'constructor', 'read', 'runIds', 'size'].sort(),
    );
    for (const forbidden of ['delete', 'remove', 'clear', 'update', 'set', 'splice']) {
      expect(methods).not.toContain(forbidden);
    }
  });
});
