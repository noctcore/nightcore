import { expect, test } from 'vitest';

import type { DebateTranscriptEntry } from '@/lib/bridge';

import { foldCouncilTranscript, hasConvergeDecision } from './council-transcript';

/** Build a transcript entry with sensible defaults for the fields a test doesn't set. */
function entry(over: Partial<DebateTranscriptEntry> & { seq: number }): DebateTranscriptEntry {
  return {
    stage: 'propose',
    seatId: 'proposer-1',
    role: 'proposer',
    kind: 'message',
    content: 'a proposal',
    at: 1_000 + over.seq,
    ...over,
  };
}

test('an empty transcript folds to no seats and no chat', () => {
  const folded = foldCouncilTranscript([]);
  expect(folded.seats).toEqual([]);
  expect(folded.chat).toEqual([]);
});

test('seat nodes are derived from each seat’s own message contributions', () => {
  const folded = foldCouncilTranscript([
    entry({ seq: 0, seatId: 'proposer-1', role: 'proposer', content: 'plan A' }),
    entry({ seq: 1, seatId: 'critic-1', role: 'critic', content: 'risk in A' }),
    entry({ seq: 2, seatId: 'proposer-1', role: 'proposer', stage: 'debate', content: 'plan A v2' }),
  ]);

  expect(folded.seats.map((s) => s.seatId)).toEqual(['proposer-1', 'critic-1']);
  const proposer = folded.seats.find((s) => s.seatId === 'proposer-1');
  expect(proposer?.messages).toHaveLength(2);
  // The node shows the seat's MOST RECENT contribution.
  expect(proposer?.latestContent).toBe('plan A v2');
  expect(proposer?.latestStage).toBe('debate');
});

test('conductor broadcasts/notes and the human never become seat nodes but do appear in chat', () => {
  const folded = foldCouncilTranscript([
    entry({ seq: 0, seatId: 'conductor', role: 'conductor', kind: 'note', stage: 'frame', content: 'framing' }),
    entry({ seq: 1, seatId: 'conductor', role: 'conductor', kind: 'broadcast', content: 'propose a plan' }),
    entry({ seq: 2, seatId: 'proposer-1', role: 'proposer', kind: 'message', content: 'plan A' }),
    entry({ seq: 3, seatId: 'human', role: 'human', kind: 'message', stage: 'converge', content: 'human note' }),
  ]);

  // Only the debating seat becomes a node.
  expect(folded.seats.map((s) => s.seatId)).toEqual(['proposer-1']);
  // But the full bus is projected into the team chat, in seq order.
  expect(folded.chat.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
  expect(folded.chat.map((c) => c.kind)).toEqual(['note', 'broadcast', 'message', 'message']);
});

test('entries are deduped by seq and ordered, so a reorder/re-delivery cannot corrupt the fold', () => {
  const folded = foldCouncilTranscript([
    entry({ seq: 2, seatId: 'critic-1', role: 'critic', content: 'later' }),
    entry({ seq: 0, seatId: 'proposer-1', role: 'proposer', content: 'first' }),
    // A re-delivery of seq 0 (last-write-wins) must not double the seat message.
    entry({ seq: 0, seatId: 'proposer-1', role: 'proposer', content: 'first' }),
  ]);

  expect(folded.chat.map((c) => c.seq)).toEqual([0, 2]);
  const proposer = folded.seats.find((s) => s.seatId === 'proposer-1');
  expect(proposer?.messages).toHaveLength(1);
});

test('a delivery entry carries its injection-scan flags into the chat projection', () => {
  const folded = foldCouncilTranscript([
    entry({
      seq: 0,
      seatId: 'proposer-1',
      role: 'critic',
      kind: 'delivery',
      stage: 'debate',
      content: 'Seat proposer-1 said: "…"',
      broadcastId: 'bc-1',
      injectionFlags: [],
    }),
  ]);

  // A delivery is a cross-seat relay, not a seat's own contribution — chat only.
  expect(folded.seats).toEqual([]);
  expect(folded.chat[0]?.kind).toBe('delivery');
  expect(folded.chat[0]?.injectionFlags).toEqual([]);
  expect(folded.chat[0]?.broadcastId).toBe('bc-1');
});

test('hasConvergeDecision flips on a converge-stage conductor note', () => {
  expect(hasConvergeDecision([entry({ seq: 0 })])).toBe(false);
  expect(
    hasConvergeDecision([
      entry({ seq: 0 }),
      entry({ seq: 1, seatId: 'conductor', role: 'conductor', kind: 'note', stage: 'converge', content: 'parked for the human judge' }),
    ]),
  ).toBe(true);
});
