import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the bridge seam so the `nc:task` subscription and the `sync_issue_status`
// IPC are fully controllable; the hook's own per-task debounce still runs.
const syncIssueStatus = vi.fn<(taskId: string) => Promise<void>>();
let taskHandler: ((task: unknown) => void) | undefined;
const onTaskEvent = vi.fn((h: (task: unknown) => void) => {
  taskHandler = h;
  return Promise.resolve(() => {});
});
vi.mock('@/lib/bridge', () => ({
  syncIssueStatus: (id: string) => syncIssueStatus(id),
  onTaskEvent: (h: (task: unknown) => void) => onTaskEvent(h),
}));

import { useIssueSync } from './useIssueSync.hooks';

afterEach(() => {
  syncIssueStatus.mockReset();
  onTaskEvent.mockReset();
  taskHandler = undefined;
});

/** A minimal `nc:task` snapshot — only the fields the observer reads. */
function taskSnapshot(id: string, issueNumber: number | null, sourceRef?: string) {
  return { id, issueNumber: issueNumber ?? undefined, sourceRef: sourceRef ?? null };
}

function Harness({ enabled }: { enabled: boolean }) {
  useIssueSync(enabled);
  return null;
}

/** Mount the observer and wait until its `nc:task` handler has subscribed. */
async function mountEnabled(): Promise<void> {
  render(<Harness enabled />);
  await vi.waitFor(() => expect(taskHandler).toBeDefined());
}

test('is inert when disabled — it never even subscribes', async () => {
  render(<Harness enabled={false} />);
  // Give effects a beat to run; a disabled observer must not subscribe at all.
  await new Promise((r) => setTimeout(r, 20));
  expect(onTaskEvent).not.toHaveBeenCalled();
  expect(taskHandler).toBeUndefined();
});

test('fires sync for an issue-linked task after the debounce, coalescing a burst', async () => {
  syncIssueStatus.mockResolvedValue();
  await mountEnabled();

  vi.useFakeTimers();
  try {
    // A rapid flap on ONE task: three emits inside the window collapse to one call.
    taskHandler!(taskSnapshot('t1', 12));
    taskHandler!(taskSnapshot('t1', 12));
    taskHandler!(taskSnapshot('t1', 12));
    expect(syncIssueStatus).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(syncIssueStatus).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(syncIssueStatus).toHaveBeenCalledTimes(1);
    expect(syncIssueStatus).toHaveBeenCalledWith('t1');
  } finally {
    vi.useRealTimers();
  }
});

test('ignores tasks with no linked issue (no number, no issue-triage sourceRef)', async () => {
  syncIssueStatus.mockResolvedValue();
  await mountEnabled();

  vi.useFakeTimers();
  try {
    // No stamped number and a non-issue provenance (e.g. a scan finding) ⇒ skipped.
    taskHandler!(taskSnapshot('t2', null, 'harness:run-7:pfp1'));
    taskHandler!(taskSnapshot('t3', null));
    vi.advanceTimersByTime(600);
    expect(syncIssueStatus).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('fires for a pre-#97 issue task via its issue-triage sourceRef (lazy backfill)', async () => {
  syncIssueStatus.mockResolvedValue();
  await mountEnabled();

  vi.useFakeTimers();
  try {
    // No stamped issueNumber, but an issue-triage sourceRef — the Rust command
    // backfills the number from the run, so the observer must still fire.
    taskHandler!(taskSnapshot('legacy', null, 'issue-triage:run-42'));
    vi.advanceTimersByTime(500);
    expect(syncIssueStatus).toHaveBeenCalledTimes(1);
    expect(syncIssueStatus).toHaveBeenCalledWith('legacy');
  } finally {
    vi.useRealTimers();
  }
});

test('debounces per task — distinct tasks each get their own writeback', async () => {
  syncIssueStatus.mockResolvedValue();
  await mountEnabled();

  vi.useFakeTimers();
  try {
    taskHandler!(taskSnapshot('a', 1));
    taskHandler!(taskSnapshot('b', 2));
    vi.advanceTimersByTime(500);
    expect(syncIssueStatus).toHaveBeenCalledTimes(2);
    expect(syncIssueStatus).toHaveBeenCalledWith('a');
    expect(syncIssueStatus).toHaveBeenCalledWith('b');
  } finally {
    vi.useRealTimers();
  }
});
