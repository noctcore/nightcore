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

import { useAllScanRuns, useHistoryFilters } from './HistoryView.hooks';
import { HistoryFilterBar, HistoryList } from './HistoryView.parts';
import type { AllScanRuns, HistoryFilters, ScanRunSummary } from './HistoryView.types';

/** A summary fixture — only the fields a given assertion cares about vary. */
function summary(over: Partial<ScanRunSummary> & Pick<ScanRunSummary, 'id' | 'family'>): ScanRunSummary {
  return {
    title: '3 conventions',
    status: 'completed',
    createdAt: Date.now(),
    projectPath: '/p',
    model: 'claude-opus-4-8',
    costUsd: 0.42,
    durationMs: 74_000,
    ...over,
  };
}

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

test('virtualizes a large run list — only a subset of rows mount', async () => {
  // The merge hook applies no limit, so a long history would otherwise mount one
  // DOM row per run. Under a bounded viewport the virtualizer keeps the mounted
  // row count far below the total. Wrapped in a fixed-height flex column so the
  // scroll container is bounded (matching how HistoryView is routed in the shell).
  const runs: ScanRunSummary[] = Array.from({ length: 400 }, (_, i) => ({
    id: `r${i}`,
    family: 'insight' as const,
    title: `${i} findings`,
    status: 'completed',
    createdAt: Date.now() - i * 1000,
    projectPath: '/p',
    model: 'claude-opus-4-8',
    costUsd: 0.1,
    durationMs: 1000,
  }));
  const screen = render(
    <div style={{ display: 'flex', flexDirection: 'column', height: 300 }}>
      <HistoryList runs={runs} loading={false} error={null} onOpenRun={() => {}} />
    </div>,
  );

  // Every mounted row is a button; the Refresh button lives on HistoryView, not
  // here, so the container's buttons are exactly the mounted rows.
  await vi.waitFor(() => {
    const mounted = screen.container.querySelectorAll('button').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(runs.length);
  });
  // A comfortably-tighter bound than "< 400": ~6 visible rows + overscan, never
  // hundreds — proves the whole list isn't in the DOM.
  expect(screen.container.querySelectorAll('button').length).toBeLessThan(60);
});

test('the footer states the retention rule with the core-supplied cap', async () => {
  // #407 prune transparency: the core drops the oldest settled runs past its cap. The
  // number comes from `AppInfo.scanRunRetention` (the enforcing Rust constant), so the
  // copy must interpolate it rather than hardcode one.
  const screen = render(
    <HistoryList
      runs={[summary({ id: 'i1', family: 'insight' })]}
      loading={false}
      error={null}
      onOpenRun={() => {}}
      retention={50}
    />,
  );
  await expect.element(screen.getByText(/50 most recent runs per kind/)).toBeInTheDocument();
});

test('a narrowed list counts what a filter is hiding instead of reading as empty', async () => {
  const screen = render(
    <HistoryList
      runs={[summary({ id: 'i1', family: 'insight' })]}
      loading={false}
      error={null}
      onOpenRun={() => {}}
      totalRuns={7}
    />,
  );
  await expect.element(screen.getByText('Showing 1 of 7')).toBeInTheDocument();
});

test('filtering everything out shows the too-narrow state, not "no runs yet"', async () => {
  const screen = render(
    <HistoryList runs={[]} loading={false} error={null} onOpenRun={() => {}} totalRuns={4} />,
  );
  await expect.element(screen.getByText('No runs match these filters')).toBeInTheDocument();
});

test('a row delete reports its family and id without opening the run', async () => {
  const onOpenRun = vi.fn();
  const onDeleteRun = vi.fn();
  const screen = render(
    <HistoryList
      runs={[summary({ id: 'h1', family: 'harness' })]}
      loading={false}
      error={null}
      onOpenRun={onOpenRun}
      onDeleteRun={onDeleteRun}
    />,
  );
  // An explicit accessible name — `/Harness/` alone would also match the row button.
  await screen.getByRole('button', { name: 'Delete this Harness run' }).click();
  expect(onDeleteRun).toHaveBeenCalledWith('harness', 'h1');
  expect(onOpenRun).not.toHaveBeenCalled();
});

test('rows carry no delete affordance when no delete handler is given', async () => {
  const screen = render(
    <HistoryList
      runs={[summary({ id: 'h1', family: 'harness' })]}
      loading={false}
      error={null}
      onOpenRun={() => {}}
    />,
  );
  await expect.element(screen.getByRole('button', { name: /Harness/ })).toBeInTheDocument();
  expect(screen.container.querySelectorAll('button')).toHaveLength(1);
});

test('the filter bar reports each kind’s loaded count and the picked filters', async () => {
  const onFamilyChange = vi.fn();
  const screen = render(
    <HistoryFilterBar
      family="insight"
      status="all"
      onFamilyChange={onFamilyChange}
      onStatusChange={() => {}}
      counts={{ insight: 2, scorecard: 0, harness: 5 }}
    />,
  );
  // The picked kind is the checked radio; the others are not.
  await expect
    .element(screen.getByRole('radio', { name: 'Insight', exact: true }))
    .toHaveAttribute('aria-checked', 'true');
  await expect
    .element(screen.getByRole('radio', { name: 'Harness', exact: true }))
    .toHaveAttribute('aria-checked', 'false');
  // The count rides along as decorative text beside the chip's accessible name.
  await expect.element(screen.getByText('5', { exact: true })).toBeInTheDocument();
  await screen.getByRole('radio', { name: 'All kinds', exact: true }).click();
  expect(onFamilyChange).toHaveBeenCalledWith('all');
});

/** Render `useHistoryFilters` over a fixed list and report its state. */
function FiltersHarness({
  runs,
  sink,
}: {
  runs: ScanRunSummary[];
  sink: (f: HistoryFilters) => void;
}) {
  const filters = useHistoryFilters(runs);
  useEffect(() => {
    sink(filters);
  });
  return null;
}

test('the filters narrow by kind and status without re-fetching', async () => {
  const runs = [
    summary({ id: 'i1', family: 'insight', status: 'completed' }),
    summary({ id: 'i2', family: 'insight', status: 'failed' }),
    summary({ id: 'h1', family: 'harness', status: 'running' }),
  ];
  let latest: HistoryFilters | undefined;
  render(<FiltersHarness runs={runs} sink={(f) => (latest = f)} />);
  await vi.waitFor(() => expect(latest).toBeDefined());

  // Unfiltered by default — nothing hidden.
  expect(latest!.visible.map((r) => r.id)).toEqual(['i1', 'i2', 'h1']);
  expect(latest!.narrowed).toBe(false);

  latest!.setFamily('insight');
  await vi.waitFor(() => expect(latest!.visible).toHaveLength(2));
  expect(latest!.visible.map((r) => r.id)).toEqual(['i1', 'i2']);
  expect(latest!.narrowed).toBe(true);

  // The two filters compose (insight AND failed), preserving newest-first order.
  latest!.setStatus('failed');
  await vi.waitFor(() => expect(latest!.visible).toHaveLength(1));
  expect(latest!.visible[0]?.id).toBe('i2');

  // A status no loaded run has yields an empty — but still narrowed — list.
  latest!.setStatus('running');
  await vi.waitFor(() => expect(latest!.visible).toHaveLength(0));
  expect(latest!.narrowed).toBe(true);
});

test('deleting a run drops its row and exposes the retention cap', async () => {
  insightMock.mockResolvedValue([
    { id: 'i1', findings: [], status: 'completed', createdAt: 20, projectPath: '/p' },
    { id: 'i2', findings: [], status: 'completed', createdAt: 10, projectPath: '/p' },
  ]);
  scorecardMock.mockResolvedValue([]);
  harnessMock.mockResolvedValue([]);

  let latest: AllScanRuns | undefined;
  render(<Harness projectPath="/p" sink={(s) => (latest = s)} />);
  await vi.waitFor(() => expect(latest?.loading).toBe(false));
  // The cap is probed from AppInfo (mocked bridge metadata outside Tauri).
  await vi.waitFor(() => expect(latest!.retention).toBe(50));

  await latest!.deleteRun('insight', 'i1');
  await vi.waitFor(() => expect(latest!.runs.map((r) => r.id)).toEqual(['i2']));
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
