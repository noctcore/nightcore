import { expect, test } from 'vitest';

import type { NcEvent } from '@/lib/bridge';

import {
  EMPTY_STREAM,
  EMPTY_TRANSCRIPT,
  foldSession,
  foldTranscript,
  type SessionStream,
  type TaskEntry,
  type TaskTranscript,
} from './session-stream';

const delta = (text: string, partial: boolean): NcEvent => ({
  type: 'assistant-delta',
  sessionId: 1,
  text,
  partial,
});

let toolUseSeq = 0;
const tool = (toolName: string, input: Record<string, unknown> = {}): NcEvent => ({
  type: 'tool-use-requested',
  sessionId: 1,
  toolUseId: `tu-${++toolUseSeq}`,
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
    { kind: 'text', id: 1, markdown: 'Looking around. Found it.', closed: true },
    { kind: 'tool', id: 1, toolName: 'Grep', input: { pattern: 'x' } },
    { kind: 'text', id: 2, markdown: 'Now editing.', closed: false },
  ]);
  expect(stream.toolSeq).toBe(1);
});

test('a tool use seals the open text turn and bumps toolCount incrementally', () => {
  const stream = fold([
    delta('a', true),
    tool('Grep'),
    delta('b', true),
    tool('Read'),
  ]);
  // Closed turns carry `closed: true`; the trailing open turn stays open. The
  // running toolCount is maintained in the fold (perf #6) rather than re-filtered.
  expect(stream.toolCount).toBe(2);
  const texts = stream.entries.filter((e) => e.kind === 'text');
  expect(texts.map((e) => e.kind === 'text' && e.closed)).toEqual([true, true]);
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
  expect(stream.entries).toEqual([{ kind: 'text', id: 1, markdown: 'Hello world', closed: false }]);
  expect(stream.streamedPartial).toBe(true);
});

test('a non-partial whole-message block appends when no partials streamed', () => {
  const stream = fold([delta('Whole message only', false)]);
  expect(stream.entries).toEqual([
    { kind: 'text', id: 1, markdown: 'Whole message only', closed: false },
  ]);
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
    { kind: 'text', id: 1, markdown: 'streamed', closed: true },
    { kind: 'tool', id: 1, toolName: 'Read', input: { file_path: 'a.ts' } },
    { kind: 'text', id: 2, markdown: 'non-streamed turn', closed: false },
  ]);
});

test('reseed parity: reducing a recorded sequence rebuilds the live entries', () => {
  const recorded: NcEvent[] = [
    {
      type: 'session-started',
      sessionId: 1,
      prompt: 'do the thing',
      model: 'opus',
      permissionMode: 'bypassPermissions',
    },
    delta('Plan: ', true),
    delta('grep then edit.', true),
    tool('Grep', { pattern: 'createClient' }),
    delta('Editing the client.', true),
    tool('Edit', { file_path: 'src/api/client.ts' }),
    {
      type: 'session-completed',
      sessionId: 1,
      result: 'done',
      costUsd: 0.2,
      numTurns: 3,
      durationMs: 1200,
    },
  ];

  // A live fold (incremental) and a reseed fold (replayed in order) are the same
  // reduce — replaying the recorded transcript must reproduce identical entries.
  const live = fold(recorded);
  const reseeded = recorded.reduce(foldSession, { ...EMPTY_STREAM });

  expect(reseeded.entries).toEqual(live.entries);
  expect(reseeded.entries).toEqual([
    { kind: 'text', id: 1, markdown: 'Plan: grep then edit.', closed: true },
    { kind: 'tool', id: 1, toolName: 'Grep', input: { pattern: 'createClient' } },
    { kind: 'text', id: 2, markdown: 'Editing the client.', closed: true },
    { kind: 'tool', id: 2, toolName: 'Edit', input: { file_path: 'src/api/client.ts' } },
  ]);
  expect(reseeded.costUsd).toBe(0.2);
});

test('session-started / session-ready reset the stream to empty', () => {
  const stream = fold([
    delta('stale', true),
    tool('Bash'),
    {
      type: 'session-ready',
      sessionId: 2,
      sdkSessionId: 'sdk-2',
      model: 'opus',
      tools: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  expect(stream).toEqual({ ...EMPTY_STREAM });
});

test('session-failed records a formatted error without touching entries', () => {
  const stream = fold([
    delta('partial output', true),
    { type: 'session-failed', sessionId: 1, reason: 'max-budget', message: 'over budget' },
  ]);
  expect(stream.error).toBe('max-budget: over budget');
  expect(stream.entries).toEqual([
    { kind: 'text', id: 1, markdown: 'partial output', closed: false },
  ]);
});

// --- task-updated (C3): the subagent-step event the board used to drop --------

const taskUpdated = (
  fields: Partial<Omit<TaskEntry, 'kind' | 'id'>> & { taskId: string; ambient?: boolean },
): NcEvent => ({
  type: 'task-updated',
  sessionId: 1,
  taskId: fields.taskId,
  status: fields.status as never,
  description: fields.description,
  summary: fields.summary,
  subagentType: fields.subagentType,
  ambient: fields.ambient ?? false,
});

test('task-updated surfaces a subagent step as its own timeline entry', () => {
  const stream = fold([
    delta('Spawning a subagent.', true),
    taskUpdated({ taskId: 'sa-1', subagentType: 'Explore', status: 'running', description: 'searching' }),
  ]);
  expect(stream.entries).toEqual([
    { kind: 'text', id: 1, markdown: 'Spawning a subagent.', closed: true },
    {
      kind: 'task',
      id: 1,
      taskId: 'sa-1',
      subagentType: 'Explore',
      description: 'searching',
      summary: undefined,
      status: 'running',
    },
  ]);
});

test('successive task-updated patches for the same taskId merge in place', () => {
  const stream = fold([
    taskUpdated({ taskId: 'sa-1', subagentType: 'Explore', status: 'running' }),
    taskUpdated({ taskId: 'sa-1', status: 'completed', summary: 'found 3 hits' }),
  ]);
  const tasks = stream.entries.filter((e): e is TaskEntry => e.kind === 'task');
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    taskId: 'sa-1',
    subagentType: 'Explore',
    status: 'completed',
    summary: 'found 3 hits',
  });
});

test('ambient task-updated steps stay out of the inline transcript', () => {
  const stream = fold([
    delta('working', true),
    taskUpdated({ taskId: 'amb-1', ambient: true, description: 'housekeeping' }),
  ]);
  expect(stream.entries).toEqual([{ kind: 'text', id: 1, markdown: 'working', closed: false }]);
});

test('an unknown / again-future event variant is tolerated (no throw, stream unchanged)', () => {
  const prev = fold([delta('hi', true)]);
  // Cast through unknown: simulates a variant this build does not yet model.
  const future = { type: 'something-new', sessionId: 1 } as unknown as NcEvent;
  expect(() => foldSession(prev, future)).not.toThrow();
  expect(foldSession(prev, future)).toBe(prev);
});

// --- foldTranscript: group a multi-session transcript by session --------------

const started = (prompt: string, model = 'opus'): NcEvent => ({
  type: 'session-started',
  sessionId: 1,
  prompt,
  model,
  permissionMode: 'bypassPermissions',
});

const ready = (sdkSessionId: string, model = 'opus'): NcEvent => ({
  type: 'session-ready',
  sessionId: 1,
  sdkSessionId,
  model,
  tools: [],
  slashCommands: [],
  skills: [],
});

const completed = (costUsd: number): NcEvent => ({
  type: 'session-completed',
  sessionId: 1,
  result: 'done',
  costUsd,
  numTurns: 1,
  durationMs: 100,
});

const foldT = (events: NcEvent[]): TaskTranscript =>
  events.reduce(foldTranscript, { ...EMPTY_TRANSCRIPT });

test('the in-progress build run survives a later verification session', () => {
  const transcript = foldT([
    // Build run.
    started('Implement the auth guard feature'),
    ready('sdk-build'),
    delta('Editing the guard.', true),
    tool('Edit', { file_path: 'src/auth/guard.ts' }),
    completed(0.4),
    // Verification run — used to wipe the build via the single-stream reset.
    started('Review the diff and verify the changes'),
    ready('sdk-verify'),
    delta('Diff looks correct.', true),
    completed(0.1),
  ]);

  expect(transcript.sessions).toHaveLength(2);
  // Build session is preserved with its activity, not collapsed away.
  expect(transcript.sessions[0]!.phase).toBe('build');
  expect(transcript.sessions[0]!.sdkSessionId).toBe('sdk-build');
  expect(transcript.sessions[0]!.stream.entries).toEqual([
    { kind: 'text', id: 1, markdown: 'Editing the guard.', closed: true },
    { kind: 'tool', id: 1, toolName: 'Edit', input: { file_path: 'src/auth/guard.ts' } },
  ]);
  // Verification session is classified and kept separately.
  expect(transcript.sessions[1]!.phase).toBe('verify');
  expect(transcript.sessions[1]!.sdkSessionId).toBe('sdk-verify');
  expect(transcript.sessions[1]!.stream.entries).toEqual([
    { kind: 'text', id: 1, markdown: 'Diff looks correct.', closed: true },
  ]);
});

test('toolCount aggregates across all sessions (drives the Logs badge)', () => {
  const transcript = foldT([
    started('build it'),
    tool('Read'),
    tool('Edit'),
    started('review it'),
    tool('Bash'),
  ]);
  expect(transcript.toolCount).toBe(3);
});

test('session-ready enriches the fresh group from session-started (no duplicate)', () => {
  const transcript = foldT([started('build it', 'sonnet'), ready('sdk-1', 'opus')]);
  expect(transcript.sessions).toHaveLength(1);
  expect(transcript.sessions[0]).toMatchObject({
    index: 1,
    sdkSessionId: 'sdk-1',
    model: 'opus',
    prompt: 'build it',
  });
});

test('foldTranscript reseed parity: replaying a recorded transcript reproduces the grouping', () => {
  const recorded: NcEvent[] = [
    started('Implement the feature'),
    ready('sdk-build'),
    delta('Working.', true),
    tool('Edit', { file_path: 'a.ts' }),
    completed(0.2),
    started('Verify the change'),
    ready('sdk-verify'),
    delta('Looks good.', true),
    completed(0.05),
  ];
  const a = foldT(recorded);
  const b = recorded.reduce(foldTranscript, { ...EMPTY_TRANSCRIPT });
  expect(b).toEqual(a);
  expect(b.sessions.map((s) => s.phase)).toEqual(['build', 'verify']);
});
