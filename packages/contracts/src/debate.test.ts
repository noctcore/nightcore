/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  DebateEntryKindSchema,
  DebateSeatRoleSchema,
  DebateStageSchema,
  DebateTranscriptEntrySchema,
} from './debate.js';

describe('DebateTranscriptEntrySchema', () => {
  const base = {
    stage: 'debate' as const,
    seatId: 'seat-a',
    role: 'proposer' as const,
    kind: 'message' as const,
    seq: 3,
    content: 'I propose we reproduce the bug first.',
    at: 1_700_000_000_000,
  };

  test('accepts a minimal message entry (no broadcastId / injectionFlags)', () => {
    const parsed = DebateTranscriptEntrySchema.parse(base);
    expect(parsed.broadcastId).toBeUndefined();
    expect(parsed.injectionFlags).toBeUndefined();
    expect(Object.keys(parsed).sort()).toEqual(
      ['at', 'content', 'kind', 'role', 'seatId', 'seq', 'stage'].sort(),
    );
  });

  test('accepts a delivery entry carrying its scan result (present, possibly empty)', () => {
    const clean = DebateTranscriptEntrySchema.parse({
      ...base,
      kind: 'delivery',
      injectionFlags: [],
    });
    expect(clean.injectionFlags).toEqual([]);

    const flagged = DebateTranscriptEntrySchema.parse({
      ...base,
      kind: 'delivery',
      injectionFlags: ['instruction-shaped phrase: "ignore previous instructions"'],
    });
    expect(flagged.injectionFlags).toHaveLength(1);
  });

  test('accepts a broadcast entry linked by broadcastId', () => {
    const parsed = DebateTranscriptEntrySchema.parse({
      ...base,
      kind: 'broadcast',
      role: 'conductor',
      broadcastId: 'bc-1',
    });
    expect(parsed.broadcastId).toBe('bc-1');
  });

  test('rejects a negative or non-integer seq (the replay ordering key)', () => {
    expect(DebateTranscriptEntrySchema.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(DebateTranscriptEntrySchema.safeParse({ ...base, seq: 1.5 }).success).toBe(false);
  });

  test('rejects an unknown stage / role / kind', () => {
    expect(DebateStageSchema.safeParse('deliberate').success).toBe(false);
    expect(DebateSeatRoleSchema.safeParse('overlord').success).toBe(false);
    expect(DebateEntryKindSchema.safeParse('command').success).toBe(false);
  });

  test('enumerates exactly the designed stages, roles, and kinds', () => {
    expect(DebateStageSchema.options).toEqual([
      'frame',
      'propose',
      'debate',
      'converge',
      'build',
      'review',
    ]);
    expect(DebateSeatRoleSchema.options).toEqual([
      'proposer',
      'critic',
      'judge',
      'conductor',
      'human',
    ]);
    expect(DebateEntryKindSchema.options).toEqual([
      'broadcast',
      'message',
      'delivery',
      'note',
    ]);
  });
});
