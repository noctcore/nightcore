import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import type { TaskTranscript } from '@/components/board';

import { useStableLogCounts } from './useStableLogCounts.hooks';

/** Build a minimal `TaskTranscript` carrying just the `toolCount` the hook reads. */
function transcript(toolCount: number): TaskTranscript {
  return { sessions: [], toolCount };
}

/** Render `useStableLogCounts` and hand each returned object back to the test so
 *  it can assert object IDENTITY (the whole point of the hook) across rerenders. */
function Harness({
  streams,
  sink,
}: {
  streams: Record<string, TaskTranscript>;
  sink: (counts: Record<string, number>) => void;
}) {
  sink(useStableLogCounts(streams));
  return null;
}

test('returns the same object identity when no tool count changed (text delta)', () => {
  const seen: Record<string, number>[] = [];
  const sink = (c: Record<string, number>) => seen.push(c);

  // A text-only `nc:session` delta yields a fresh streams map with identical
  // tool counts. The hook must not hand a new counts object downstream.
  const s1 = { a: transcript(2), b: transcript(0) };
  const { rerender } = render(<Harness streams={s1} sink={sink} />);
  const s2 = { a: transcript(2), b: transcript(0) };
  rerender(<Harness streams={s2} sink={sink} />);

  expect(seen[0]).toEqual({ a: 2, b: 0 });
  expect(seen[seen.length - 1]).toBe(seen[0]);
});

test('returns a new object when a tool count advances, reflecting the value', () => {
  const seen: Record<string, number>[] = [];
  const sink = (c: Record<string, number>) => seen.push(c);

  const { rerender } = render(<Harness streams={{ a: transcript(1) }} sink={sink} />);
  const first = seen[seen.length - 1];
  rerender(<Harness streams={{ a: transcript(2) }} sink={sink} />);
  const second = seen[seen.length - 1];

  expect(first).toEqual({ a: 1 });
  expect(second).toEqual({ a: 2 });
  expect(second).not.toBe(first);
});

test('returns a new object when a task id is added or removed', () => {
  const seen: Record<string, number>[] = [];
  const sink = (c: Record<string, number>) => seen.push(c);

  const { rerender } = render(<Harness streams={{ a: transcript(1) }} sink={sink} />);
  const first = seen[seen.length - 1];
  // Added id.
  rerender(<Harness streams={{ a: transcript(1), b: transcript(0) }} sink={sink} />);
  const second = seen[seen.length - 1];
  expect(second).not.toBe(first);
  expect(second).toEqual({ a: 1, b: 0 });

  // Equal-size id swap (b removed, c added) must still be detected.
  rerender(<Harness streams={{ a: transcript(1), c: transcript(0) }} sink={sink} />);
  const third = seen[seen.length - 1];
  expect(third).not.toBe(second);
  expect(third).toEqual({ a: 1, c: 0 });
});
