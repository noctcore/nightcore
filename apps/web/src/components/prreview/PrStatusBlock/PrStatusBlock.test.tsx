import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command seam under the bridge so `pr_status_by_number` is
// controllable per test (the PrStatusCard.test seam).
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import type { PrStatus } from '@/lib/bridge';

import { PrStatusBlock } from './PrStatusBlock';
import { usePrStatusByNumber } from './PrStatusBlock.hooks';

function makeStatus(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BEHIND',
    reviewDecision: 'REVIEW_REQUIRED',
    checksPassed: 4,
    checksFailed: 1,
    checksPending: 2,
    baseRefName: 'main',
    headRefOid: 'a1b2c3d4',
    url: 'https://github.com/o/r/pull/128',
    number: 128,
    unpushedCommits: 0,
    ...over,
  };
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

test('shows the loading line while the fetch is in flight', async () => {
  invoke.mockImplementation(() => new Promise(() => {}));
  const screen = render(<PrStatusBlock prNumber={128} />);
  await expect
    .element(screen.getByText(/fetching pr status/i))
    .toBeInTheDocument();
});

test('renders badges, merge line, checks, and base branch from the fetched status', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'pr_status_by_number'
      ? Promise.resolve(makeStatus())
      : Promise.resolve(undefined),
  );
  const screen = render(<PrStatusBlock prNumber={128} />);
  await expect.element(screen.getByText('Open', { exact: true })).toBeInTheDocument();
  await expect
    .element(screen.getByText('Review required', { exact: true }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('Behind base')).toBeInTheDocument();
  await expect.element(screen.getByText(/4 passed/)).toBeInTheDocument();
  await expect.element(screen.getByText(/1 failed/)).toBeInTheDocument();
  await expect.element(screen.getByText(/2 pending/)).toBeInTheDocument();
  await expect.element(screen.getByText(/base: main/)).toBeInTheDocument();
});

test('a rejected fetch surfaces the error inline with the failed-to-load line', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'pr_status_by_number'
      ? Promise.reject(new Error('gh: authentication required'))
      : Promise.resolve(undefined),
  );
  const screen = render(<PrStatusBlock prNumber={128} />);
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent(/gh: authentication required/);
  await expect
    .element(screen.getByText(/pr status failed to load/i))
    .toBeInTheDocument();
});

test('a null resolution shows the unavailable note (browser preview sentinel)', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'pr_status_by_number' ? Promise.resolve(null) : Promise.resolve(undefined),
  );
  const screen = render(<PrStatusBlock prNumber={128} />);
  await expect
    .element(screen.getByText(/unavailable in the browser preview/i))
    .toBeInTheDocument();
});

/** Records one `<prNumber>:<fetching>:<status>` frame per render, so the tests
 *  below can assert a state NEVER painted (not just what settled). */
function FramesHarness({ prNumber, frames }: { prNumber: number; frames: string[] }) {
  const view = usePrStatusByNumber(prNumber);
  frames.push(
    `${prNumber}:${view.fetching ? 'fetching' : 'idle'}:${
      view.status === null ? 'null' : 'loaded'
    }`,
  );
  return null;
}

test('no "not loaded yet" flash: fetching is seeded true on mount and across PR switches', async () => {
  invoke.mockImplementation((cmd: unknown, args: unknown) => {
    if (cmd !== 'pr_status_by_number') return Promise.resolve(undefined);
    const { number } = args as { number: number };
    // #128 resolves; #129 stays in flight forever.
    return number === 128 ? Promise.resolve(makeStatus()) : new Promise(() => {});
  });
  const frames: string[] = [];
  const screen = render(<FramesHarness prNumber={128} frames={frames} />);
  await vi.waitFor(() => expect(frames).toContain('128:idle:loaded'));
  // Every pre-load frame reported fetching — the idle "not loaded yet"
  // combination (status null, not fetching) never painted.
  expect(frames).not.toContain('128:idle:null');

  // Switching PRs resets the snapshot AND seeds fetching in the same
  // render-adjust, so the switched-to PR never flashes "not loaded yet".
  screen.rerender(<FramesHarness prNumber={129} frames={frames} />);
  await vi.waitFor(() => expect(frames).toContain('129:fetching:null'));
  expect(frames).not.toContain('129:idle:null');
});

test('the Refresh control re-fetches the status', async () => {
  let calls = 0;
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd !== 'pr_status_by_number') return Promise.resolve(undefined);
    calls += 1;
    return Promise.resolve(makeStatus({ mergeStateStatus: calls > 1 ? 'CLEAN' : 'BEHIND' }));
  });
  const screen = render(<PrStatusBlock prNumber={128} />);
  await expect.element(screen.getByText('Behind base')).toBeInTheDocument();
  await screen.getByRole('button', { name: /refresh/i }).click();
  await expect.element(screen.getByText('Clean against base')).toBeInTheDocument();
  expect(calls).toBe(2);
});

test('the merge-readiness badge leads the badge row', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'pr_status_by_number'
      ? Promise.resolve(makeStatus({ checksFailed: 0, checksPending: 0 }))
      : Promise.resolve(undefined),
  );
  const screen = render(<PrStatusBlock prNumber={128} />);
  // REVIEW_REQUIRED with green checks → "Needs review".
  await expect
    .element(screen.getByText('Needs review', { exact: true }))
    .toBeInTheDocument();
});

test('remediation buttons render from the status and arm their gates', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'pr_status_by_number'
      ? Promise.resolve(makeStatus({ mergeable: 'CONFLICTING', checksFailed: 1 }))
      : Promise.resolve(undefined),
  );
  const onFixCi = vi.fn();
  const onResolveConflicts = vi.fn();
  const screen = render(
    <PrStatusBlock
      prNumber={128}
      actions={{ onFixCi, onResolveConflicts, fixBusy: false }}
    />,
  );
  await screen.getByRole('button', { name: /fix ci/i }).click();
  expect(onFixCi).toHaveBeenCalledTimes(1);
  await screen.getByRole('button', { name: /resolve conflicts/i }).click();
  expect(onResolveConflicts).toHaveBeenCalledTimes(1);
});

test('remediation buttons hide without their trigger states or the actions prop', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'pr_status_by_number'
      ? Promise.resolve(makeStatus({ mergeable: 'MERGEABLE', checksFailed: 0 }))
      : Promise.resolve(undefined),
  );
  const screen = render(
    <PrStatusBlock
      prNumber={128}
      actions={{ onFixCi: vi.fn(), onResolveConflicts: vi.fn(), fixBusy: false }}
    />,
  );
  await expect.element(screen.getByText(/base: main/)).toBeInTheDocument();
  expect(screen.container.textContent).not.toMatch(/Fix CI/);
  expect(screen.container.textContent).not.toMatch(/Resolve conflicts/);
});

test('busy remediation buttons are inert but focusable, with the reason wired', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'pr_status_by_number'
      ? Promise.resolve(makeStatus({ checksFailed: 1 }))
      : Promise.resolve(undefined),
  );
  const onFixCi = vi.fn();
  const screen = render(
    <PrStatusBlock
      prNumber={128}
      actions={{ onFixCi, onResolveConflicts: vi.fn(), fixBusy: true }}
    />,
  );
  const button = screen.getByRole('button', { name: /fix ci/i });
  await expect.element(button).toHaveAttribute('aria-disabled', 'true');
  await expect.element(button).toHaveAttribute('aria-describedby');
  // Playwright refuses to click aria-disabled controls (actionability) — that
  // refusal is itself the guard working. Fire a NATIVE click to prove the
  // handler guard holds even without the actionability layer.
  screen.container
    .querySelector<HTMLButtonElement>('button[aria-disabled="true"]')
    ?.click();
  expect(onFixCi).not.toHaveBeenCalled();
});
