import { useEffect } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the bridge seam: capture the `nc:session` and `nc:task` subscribers so
// tests can push stream deltas and status transitions, and make `listTasks` /
// `readTranscript` controllable so we can seed the board and exercise the
// drawer-reopen reseed after an eviction.
let sessionHandler: ((envelope: SessionEnvelope) => void) | undefined;
let taskHandler: ((task: Task) => void) | undefined;
const listTasks = vi.fn<() => Promise<Task[]>>();
const readTranscript = vi.fn<(id: string) => Promise<NcEvent[]>>();
vi.mock('@/lib/bridge', () => ({
  listTasks: () => listTasks(),
  readTranscript: (id: string) => readTranscript(id),
  onSessionEvent: (h: (envelope: SessionEnvelope) => void) => {
    sessionHandler = h;
    return Promise.resolve(() => {});
  },
  onTaskEvent: (h: (task: Task) => void) => {
    taskHandler = h;
    return Promise.resolve(() => {});
  },
  onProjectEvent: () => Promise.resolve(() => {}),
}));

// Use the REAL fold + status vocabulary (reseed parity depends on folding a
// reopened task's JSONL identically), pulled from the source modules so the test
// never drags the whole board barrel (Board/TaskDetail/…) into the browser run.
vi.mock('@/components/board', async () => {
  const stream = await vi.importActual<typeof import('@/components/board/session-stream')>(
    '@/components/board/session-stream',
  );
  const status = await vi.importActual<typeof import('@/components/board/status')>(
    '@/components/board/status',
  );
  return {
    EMPTY_TRANSCRIPT: stream.EMPTY_TRANSCRIPT,
    foldTranscript: stream.foldTranscript,
    isActive: status.isActive,
  };
});

import type { ToastApi } from '@/components/ui';
import type { NcEvent, SessionEnvelope, Task, TaskStatus } from '@/lib/bridge';

import { useBoard } from './useBoard.hooks';

afterEach(() => {
  listTasks.mockReset();
  readTranscript.mockReset();
  sessionHandler = undefined;
  taskHandler = undefined;
});

function fakeToast(): ToastApi {
  return { toasts: [], push: vi.fn(() => 1), error: vi.fn(() => 1), dismiss: vi.fn() };
}

/** A minimal task — only `id`/`status`/`seq` are read by the board hook. */
function task(id: string, status: TaskStatus, seq = 1): Task {
  return { id, status, seq } as Task;
}

/** A whole-message assistant turn — folds into a non-empty transcript. */
function delta(text: string): NcEvent {
  return { type: 'assistant-delta', sessionId: 1, text, partial: false };
}

type Board = ReturnType<typeof useBoard>;

function Harness({ toast, sink }: { toast: ToastApi; sink: (b: Board) => void }) {
  const board = useBoard(toast);
  useEffect(() => {
    sink(board);
  });
  return null;
}

async function mount(seed: Task[]): Promise<{ get: () => Board; toast: ToastApi }> {
  listTasks.mockResolvedValue(seed);
  readTranscript.mockResolvedValue([]);
  const toast = fakeToast();
  let latest: Board | undefined;
  render(<Harness toast={toast} sink={(b) => (latest = b)} />);
  await vi.waitFor(() => expect(latest).toBeDefined());
  await vi.waitFor(() => expect(sessionHandler).toBeDefined());
  // Wait for the async `listTasks` seed to land so status is derivable.
  await vi.waitFor(() => expect(latest!.tasks).toHaveLength(seed.length));
  return { get: () => latest!, toast };
}

/** Push a stream delta for a task and let the coalescing flush (rAF) apply it. */
function pushDelta(taskId: string): void {
  sessionHandler!({ taskId, event: delta(`activity for ${taskId}`) });
}

test('flush evicts a completed, non-selected task’s stream but keeps the running and selected ones', async () => {
  // R runs (never evictable), S is the open drawer (retained), D is completed and
  // not selected (evictable).
  const { get } = await mount([task('R', 'in_progress'), task('S', 'done'), task('D', 'done')]);

  get().setSelectedId('S');
  await vi.waitFor(() => expect(get().selectedId).toBe('S'));

  // One coalesced flush folds all three, then prunes in the same pass.
  pushDelta('R');
  pushDelta('S');
  pushDelta('D');

  // Once R's stream lands the batch has flushed — so D was folded then evicted.
  await vi.waitFor(() => expect(get().streams['R']).toBeDefined());
  expect(get().streams['S']).toBeDefined(); // selected → retained
  expect(get().streams['D']).toBeUndefined(); // completed + unselected → evicted
});

test('reopening an evicted task’s drawer re-seeds its stream from readTranscript', async () => {
  const { get } = await mount([task('R', 'in_progress'), task('S', 'done'), task('D', 'done')]);
  // D's persisted transcript re-folds on reopen; other reads stay empty.
  readTranscript.mockImplementation((id) => Promise.resolve(id === 'D' ? [delta('recovered')] : []));

  get().setSelectedId('S');
  await vi.waitFor(() => expect(get().selectedId).toBe('S'));
  pushDelta('R');
  pushDelta('S');
  pushDelta('D');
  await vi.waitFor(() => expect(get().streams['R']).toBeDefined());
  expect(get().streams['D']).toBeUndefined(); // evicted first

  // Reopen D's drawer — the reseed effect re-folds its JSONL (its stream is absent,
  // so the "skip if present" guard doesn't block re-hydration).
  get().setSelectedId('D');
  await vi.waitFor(() => expect(get().streams['D']).toBeDefined());
  expect(get().streams['D']?.sessions.length).toBeGreaterThan(0);
});

test('a status transition to a terminal state evicts a non-selected stream without a flush', async () => {
  const { get } = await mount([task('A', 'in_progress')]);

  // A is running → its stream is kept through the flush.
  pushDelta('A');
  await vi.waitFor(() => expect(get().streams['A']).toBeDefined());

  // A completes (nc:task upsert, higher seq). No further session events fire, so
  // only the status-transition prune can reclaim it.
  taskHandler!(task('A', 'done', 2));
  await vi.waitFor(() => expect(get().streams['A']).toBeUndefined());
});
