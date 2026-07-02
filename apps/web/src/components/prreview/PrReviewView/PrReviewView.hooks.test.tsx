import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command seam under the bridge (the useCreatePr.hooks.test.tsx
// pattern) so `start_pr_review`/`list_pr_review_runs` are controllable per test.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { ToastProvider } from '@/components/ui';
import type { ReviewLens } from '@/lib/bridge';
import type { PrReviewRun } from '@/lib/generated/PrReviewRun';

import {
  type PrReviewViewModel,
  usePrReview,
  type UsePrReviewResult,
  usePrReviewView,
} from './PrReviewView.hooks';

const SECURITY: ReviewLens[] = ['security'];

/** `tauriInvoke` is a no-op outside Tauri; flip the detection so the bridge's
 *  list/get wrappers reach the mocked `invoke`. `start_pr_review` uses raw
 *  `invoke` regardless, but the integration test needs the list wrapper live. */
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function StartHarness({ sink }: { sink: (r: UsePrReviewResult) => void }) {
  const pr = usePrReview(true);
  useEffect(() => {
    sink(pr);
  });
  return null;
}

test('start() resolves false and surfaces startError when the gh diff fetch rejects', async () => {
  // start_pr_review runs a synchronous `gh pr diff` fetch that rejects on common
  // inputs (missing PR, expired token). The rejection must be observable.
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'start_pr_review'
      ? Promise.reject(new Error('no pull request found for #999'))
      : Promise.resolve([]),
  );
  let pr: UsePrReviewResult | undefined;
  render(<StartHarness sink={(r) => (pr = r)} />);
  await vi.waitFor(() => expect(pr).toBeDefined());

  await expect(pr!.start(999, SECURITY, null, null)).resolves.toBe(false);
  await vi.waitFor(() =>
    expect(pr!.startError).toBe('no pull request found for #999'),
  );
});

test('start() resolves true and clears startError when the run starts', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'start_pr_review' ? Promise.resolve('run-1') : Promise.resolve([]),
  );
  let pr: UsePrReviewResult | undefined;
  render(<StartHarness sink={(r) => (pr = r)} />);
  await vi.waitFor(() => expect(pr).toBeDefined());

  await expect(pr!.start(42, SECURITY, null, null)).resolves.toBe(true);
  expect(pr!.startError).toBeNull();
});

function ViewHarness({ sink }: { sink: (m: PrReviewViewModel) => void }) {
  const model = usePrReviewView({
    projectPath: '/p',
    projectName: 'acme',
    onGotoBoard: () => {},
    preselect: null,
    onPreselectConsumed: () => {},
  });
  useEffect(() => {
    sink(model);
  });
  return null;
}

function completedRun(): PrReviewRun {
  return {
    id: 'run-10',
    projectPath: '/p',
    prNumber: 42,
    status: 'completed',
    lenses: ['security'],
    model: 'claude',
    createdAt: 1,
    updatedAt: 2,
    costUsd: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    findings: [],
    error: null,
  };
}

test('a failed re-run over a completed run stays on CONFIGURE so the error is seen', async () => {
  // Regression: `onReview` used to clear `reconfiguring` eagerly, so a rejected
  // start dropped the view to the prior run's stale RESULTS — where startError is
  // never rendered. It must stay on CONFIGURE (which shows the error banner).
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'list_pr_review_runs') return Promise.resolve([completedRun()]);
    if (cmd === 'get_pr_review_run') return Promise.resolve(completedRun());
    if (cmd === 'start_pr_review') {
      return Promise.reject(new Error('gh: authentication required'));
    }
    return Promise.resolve(undefined);
  });
  let model: PrReviewViewModel | undefined;
  render(
    <ToastProvider>
      <ViewHarness sink={(m) => (model = m)} />
    </ToastProvider>,
  );
  // Mount auto-displays the newest (completed) run → RESULTS.
  await vi.waitFor(() => expect(model?.phase).toBe('results'));

  // "New run" → prefilled CONFIGURE from the completed run.
  model!.startNewRun();
  await vi.waitFor(() => expect(model?.phase).toBe('configure'));

  // Rejected re-run: must NOT fall back to the stale RESULTS.
  void model!.onReview();
  await vi.waitFor(() =>
    expect(model?.startError).toBe('gh: authentication required'),
  );
  expect(model?.phase).toBe('configure');
});
