import { useEffect } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock only the three per-family list commands the merge hook fans out over;
// everything else in the bridge stays real. Spies are hoisted so the (hoisted)
// `vi.mock` factory can close over them.
const { insightMock, scorecardMock, harnessMock } = vi.hoisted(() => ({
  insightMock: vi.fn(),
  scorecardMock: vi.fn(),
  harnessMock: vi.fn(),
}));
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    listInsightRuns: insightMock,
    listScorecardRuns: scorecardMock,
    listHarnessRuns: harnessMock,
  };
});

import { useAllScanRuns } from './HistoryView.hooks';
import { HistoryList } from './HistoryView.parts';
import type { AllScanRuns, ScanRunSummary } from './HistoryView.types';

/** Render `useAllScanRuns` and report its latest state to the test. */
function Harness({
  projectPath,
  sink,
}: {
  projectPath: string | null;
  sink: (s: AllScanRuns) => void;
}) {
  const state = useAllScanRuns(projectPath);
  useEffect(() => {
    sink(state);
  });
  return null;
}

// The spies are module-level (hoisted); clear their call history between tests so
// a prior test's fan-out can't bleed into a later `not.toHaveBeenCalled` assertion.
beforeEach(() => {
  vi.clearAllMocks();
});

test('merges the three families, filters to the project, and sorts newest-first', async () => {
  insightMock.mockResolvedValue([
    { id: 'i1', findings: [1, 2], status: 'completed', createdAt: 30, projectPath: '/p' },
    { id: 'i-other', findings: [], status: 'completed', createdAt: 99, projectPath: '/other' },
  ]);
  scorecardMock.mockResolvedValue([
    { id: 's1', readings: [1], status: 'running', createdAt: 20, projectPath: '/p' },
  ]);
  harnessMock.mockResolvedValue([
    { id: 'h1', findings: [1, 2, 3], status: 'failed', createdAt: 10, projectPath: '/p' },
  ]);

  let latest: AllScanRuns | undefined;
  render(<Harness projectPath="/p" sink={(s) => (latest = s)} />);
  await vi.waitFor(() => expect(latest?.loading).toBe(false));

  // Newest-first by createdAt; the `/other` project run is filtered out.
  expect(latest!.runs.map((r) => r.id)).toEqual(['i1', 's1', 'h1']);
  expect(latest!.runs.map((r) => r.family)).toEqual(['insight', 'scorecard', 'harness']);
  expect(latest!.runs[0]?.title).toBe('2 findings');
  expect(latest!.error).toBeNull();
});

test('a failing family still yields the others plus a non-blocking warning', async () => {
  insightMock.mockResolvedValue([
    { id: 'i1', findings: [], status: 'completed', createdAt: 5, projectPath: '/p' },
  ]);
  scorecardMock.mockResolvedValue([
    { id: 's1', readings: [], status: 'completed', createdAt: 6, projectPath: '/p' },
  ]);
  harnessMock.mockRejectedValue(new Error('backend down'));

  let latest: AllScanRuns | undefined;
  render(<Harness projectPath="/p" sink={(s) => (latest = s)} />);
  await vi.waitFor(() => expect(latest?.loading).toBe(false));

  expect(latest!.runs.map((r) => r.id)).toEqual(['s1', 'i1']);
  expect(latest!.error).toContain('Harness');
});

test('no active project loads nothing and settles empty', async () => {
  insightMock.mockResolvedValue([]);
  scorecardMock.mockResolvedValue([]);
  harnessMock.mockResolvedValue([]);

  let latest: AllScanRuns | undefined;
  render(<Harness projectPath={null} sink={(s) => (latest = s)} />);
  await vi.waitFor(() => expect(latest?.loading).toBe(false));

  expect(latest!.runs).toEqual([]);
  expect(insightMock).not.toHaveBeenCalled();
});

test('HistoryList shows the empty state when there are no runs', async () => {
  const screen = render(
    <HistoryList runs={[]} loading={false} error={null} onOpenRun={() => {}} />,
  );
  await expect.element(screen.getByText('No scan runs yet')).toBeInTheDocument();
});

test('a row click opens the run with its family and id', async () => {
  const onOpenRun = vi.fn();
  const runs: ScanRunSummary[] = [
    {
      id: 'h1',
      family: 'harness',
      title: '3 conventions',
      status: 'completed',
      createdAt: Date.now(),
      projectPath: '/p',
      model: 'claude-opus-4-8',
      costUsd: 0.42,
      durationMs: 74_000,
    },
  ];
  const screen = render(
    <HistoryList runs={runs} loading={false} error={null} onOpenRun={onOpenRun} />,
  );
  await screen.getByRole('button', { name: /Harness/ }).click();
  expect(onOpenRun).toHaveBeenCalledWith('harness', 'h1');
});

test('a row surfaces the persisted run receipt (approximate cost + duration)', async () => {
  const runs: ScanRunSummary[] = [
    {
      id: 'h1',
      family: 'harness',
      title: '3 conventions',
      status: 'completed',
      createdAt: Date.now(),
      projectPath: '/p',
      model: 'claude-opus-4-8',
      costUsd: 0.42,
      durationMs: 74_000,
    },
  ];
  const screen = render(
    <HistoryList runs={runs} loading={false} error={null} onOpenRun={() => {}} />,
  );
  await expect.element(screen.getByText(/≈ \$0\.42 · 1m 14s/)).toBeInTheDocument();
});

test('a warning row renders above the list without blanking it', async () => {
  const runs: ScanRunSummary[] = [
    {
      id: 'i1',
      family: 'insight',
      title: '2 findings',
      status: 'completed',
      createdAt: Date.now(),
      projectPath: '/p',
      model: 'claude-opus-4-8',
      costUsd: 0.42,
      durationMs: 74_000,
    },
  ];
  const screen = render(
    <HistoryList
      runs={runs}
      loading={false}
      error="Couldn’t load Harness history — showing what loaded."
      onOpenRun={() => {}}
    />,
  );
  await expect.element(screen.getByText(/Couldn’t load Harness/)).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /Insight/ })).toBeInTheDocument();
});
