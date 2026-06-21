import { expect, test } from 'vitest';
import type { NcEvent } from '@/lib/bridge';
import { EMPTY_STREAM, foldSession, type SessionStream } from './session-stream';

const delta = (text: string, partial: boolean): NcEvent => ({
  type: 'assistant-delta',
  sessionId: 1,
  text,
  partial,
});

const tool = (toolName: string, input: Record<string, unknown> = {}): NcEvent => ({
  type: 'tool-use-requested',
  sessionId: 1,
  toolName,
  input,
});

const fold = (events: NcEvent[]): SessionStream =>
  events.reduce(foldSession, { ...EMPTY_STREAM });

test('interleaves text → tool → text into [text, tool, text] in arrival order', () => {
  const stream = fold([
    delta('Looking around. ', true),
    delta('Found it.', true),
    tool('Grep', { pattern: 'x' }),
    delta('Now editing.', true),
  ]);

  expect(stream.entries).toEqual([
    { kind: 'text', markdown: 'Looking around. Found it.' },
    { kind: 'tool', id: 1, toolName: 'Grep', input: { pattern: 'x' } },
    { kind: 'text', markdown: 'Now editing.' },
  ]);
  expect(stream.toolSeq).toBe(1);
});

test('a tool use closes the open text turn so two turns stay distinct', () => {
  const stream = fold([
    delta('Turn one.', true),
    tool('Bash', { command: 'ls' }),
    delta('Turn two.', true),
  ]);
  const texts = stream.entries.filter((e) => e.kind === 'text');
  expect(texts).toHaveLength(2);
  expect(stream.entries.map((e) => e.kind)).toEqual(['text', 'tool', 'text']);
});

test('suppresses the whole-message block when partials already streamed (dedup)', () => {
  const stream = fold([
    delta('Hello ', true),
    delta('world', true),
    // The SDK re-emits the full message as a non-partial block — must be dropped.
    delta('Hello world', false),
  ]);
  expect(stream.entries).toEqual([{ kind: 'text', markdown: 'Hello world' }]);
  expect(stream.streamedPartial).toBe(true);
});

test('a non-partial whole-message block appends when no partials streamed', () => {
  const stream = fold([delta('Whole message only', false)]);
  expect(stream.entries).toEqual([{ kind: 'text', markdown: 'Whole message only' }]);
});

test('partial flag resets on each tool use so a later whole-message block is kept', () => {
  const stream = fold([
    delta('streamed', true),
    tool('Read', { file_path: 'a.ts' }),
    // After a tool, streamedPartial is false again — this whole-message block
    // opens a fresh text entry rather than being suppressed.
    delta('non-streamed turn', false),
  ]);
  expect(stream.entries).toEqual([
    { kind: 'text', markdown: 'streamed' },
    { kind: 'tool', id: 1, toolName: 'Read', input: { file_path: 'a.ts' } },
    { kind: 'text', markdown: 'non-streamed turn' },
  ]);
});

test('reseed parity: reducing a recorded sequence rebuilds the live entries', () => {
  const recorded: NcEvent[] = [
    { type: 'session-started', sessionId: 1, model: 'opus', permissionMode: 'bypass' },
    delta('Plan: ', true),
    delta('grep then edit.', true),
    tool('Grep', { pattern: 'createClient' }),
    delta('Editing the client.', true),
    tool('Edit', { file_path: 'src/api/client.ts' }),
    { type: 'session-completed', sessionId: 1, costUsd: 0.2, numTurns: 3, durationMs: 1200 },
  ];

  // A live fold (incremental) and a reseed fold (replayed in order) are the same
  // reduce — replaying the recorded transcript must reproduce identical entries.
  const live = fold(recorded);
  const reseeded = recorded.reduce(foldSession, { ...EMPTY_STREAM });

  expect(reseeded.entries).toEqual(live.entries);
  expect(reseeded.entries).toEqual([
    { kind: 'text', markdown: 'Plan: grep then edit.' },
    { kind: 'tool', id: 1, toolName: 'Grep', input: { pattern: 'createClient' } },
    { kind: 'text', markdown: 'Editing the client.' },
    { kind: 'tool', id: 2, toolName: 'Edit', input: { file_path: 'src/api/client.ts' } },
  ]);
  expect(reseeded.costUsd).toBe(0.2);
});

test('session-started / session-ready reset the stream to empty', () => {
  const stream = fold([
    delta('stale', true),
    tool('Bash'),
    { type: 'session-ready', sessionId: 2, sdkSessionId: 'sdk-2', model: 'opus' },
  ]);
  expect(stream).toEqual({ ...EMPTY_STREAM });
});

test('session-failed records a formatted error without touching entries', () => {
  const stream = fold([
    delta('partial output', true),
    { type: 'session-failed', sessionId: 1, reason: 'budget_exhausted', message: 'over budget' },
  ]);
  expect(stream.error).toBe('budget_exhausted: over budget');
  expect(stream.entries).toEqual([{ kind: 'text', markdown: 'partial output' }]);
});
