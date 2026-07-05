import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri seams so the full two-panel workspace renders against
// controllable `list_open_prs` / run-store / status / login commands.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { composeStories } from '@storybook/react-vite';

import { ToastProvider } from '@/components/ui';
import type {
  PrFixState,
  PrStatus,
  PrSummary,
  StoredReviewFinding,
} from '@/lib/bridge';
import type { PrReviewRun } from '@/lib/generated/PrReviewRun';

import { OWN_PR_TITLE } from '../ReviewSection/ReviewSection.hooks';
import { PrReviewView } from './PrReviewView';
import * as stories from './PrReviewView.stories';

const { Idle, NoProject } = composeStories(stories);

function summary(over: Partial<PrSummary> & Pick<PrSummary, 'number'>): PrSummary {
  return {
    title: 'Untitled',
    state: 'OPEN',
    headRefName: 'branch',
    author: 'octocat',
    isDraft: false,
    createdAt: '2026-06-20T09:00:00Z',
    updatedAt: '2026-07-02T12:00:00Z',
    url: `https://github.com/o/r/pull/${over.number}`,
    labels: [],
    body: '',
    additions: 0,
    deletions: 0,
    ...over,
  };
}

function storedFinding(over: Partial<StoredReviewFinding> = {}): StoredReviewFinding {
  return {
    id: 'sf1',
    lens: 'logic',
    severity: 'high',
    file: 'src/a.ts',
    line: 4,
    title: 'Unchecked unwrap in the hot path',
    body: 'b',
    suggestedFix: null,
    fingerprint: 'fp-sf1',
    corroboratedBy: null,
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

function persistedRun(over: Partial<PrReviewRun> = {}): PrReviewRun {
  return {
    id: 'run-10',
    projectPath: '/p',
    prNumber: 42,
    status: 'completed',
    lenses: ['security'],
    model: 'claude',
    createdAt: 1000,
    updatedAt: 2000,
    costUsd: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    findings: [],
    error: null,
    verdict: null,
    verdictReasoning: null,
    headSha: null,
    postedVerdict: null,
    postedAt: null,
    ...over,
  };
}

function makeStatus(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BEHIND',
    reviewDecision: '',
    checksPassed: 2,
    checksFailed: 0,
    checksPending: 0,
    baseRefName: 'main',
    headRefOid: 'sha-head',
    url: 'https://github.com/o/r/pull/42',
    number: 42,
    unpushedCommits: 0,
    ...over,
  };
}

function makeFix(over: Partial<PrFixState> = {}): PrFixState {
  return {
    id: 'prfix-1',
    kind: 'findings',
    runId: 'run-10',
    prNumber: 42,
    branch: 'feat/x',
    dir: '/wt',
    status: 'awaiting_push',
    summary: 'Handled the unwrap.',
    error: null,
    findingCount: 1,
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

/** Baseline invoke behavior; tests override per-command via `handlers`. */
function mockCommands(handlers: Record<string, (args: unknown) => unknown>) {
  invoke.mockImplementation((cmd: unknown, args: unknown) => {
    const handler = handlers[cmd as string];
    if (handler !== undefined) return Promise.resolve(handler(args));
    if (cmd === 'list_open_prs') return Promise.resolve([]);
    if (cmd === 'list_pr_review_runs') return Promise.resolve([]);
    if (cmd === 'list_pr_fixes') return Promise.resolve([]);
    if (cmd === 'viewer_login') return Promise.resolve(null);
    if (cmd === 'pr_status_by_number') return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
}

function renderView() {
  return render(
    <ToastProvider>
      <PrReviewView
        projectPath="/p"
        projectName="acme"
        onGotoBoard={() => {}}
        preselect={null}
        onPreselectConsumed={() => {}}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  // Baseline command behavior so story-driven renders never hit a void invoke;
  // tests override with their own `mockCommands(...)` call.
  mockCommands({});
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

test('renders the two-panel workspace: PR list + empty prompt, then selection opens the workspace', async () => {
  mockCommands({
    list_open_prs: () => [
      summary({ number: 128, title: 'Harden the worktree isolation gate' }),
    ],
  });
  const screen = renderView();

  // Both panels render permanently: the list header + the empty right prompt.
  await expect
    .element(screen.getByText('Pull requests', { exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/select a pull request to review/i))
    .toBeInTheDocument();

  // Selecting a PR opens its workspace on the right (title + review config).
  await screen.getByRole('option', { name: /#128/ }).click();
  await expect
    .element(screen.getByRole('heading', { name: /harden the worktree/i }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /^review pr #128$/i }))
    .toBeEnabled();
});

test('the left list shows per-PR badges from the registry (running + finding count)', async () => {
  mockCommands({
    list_open_prs: () => [summary({ number: 7 }), summary({ number: 128 })],
    list_pr_review_runs: () => [
      persistedRun({ id: 'run-live', prNumber: 7, status: 'running' }),
      persistedRun({
        id: 'run-done',
        prNumber: 128,
        findings: [storedFinding(), storedFinding({ id: 'sf2', fingerprint: 'fp-2' })],
      }),
    ],
  });
  const screen = renderView();

  // The badges are visible/sr-only text inside each option (never aria-labels
  // on generic spans), so they assert through the option rows directly.
  await expect
    .element(screen.getByRole('option', { name: /#7/ }))
    .toHaveTextContent('Reviewing');
  await expect
    .element(screen.getByRole('option', { name: /#128/ }))
    .toHaveTextContent(/2\s*open findings/);
});

test('the status block renders the fetched gh snapshot for the selected PR', async () => {
  mockCommands({
    list_open_prs: () => [summary({ number: 42 })],
    pr_status_by_number: () => makeStatus(),
  });
  const screen = renderView();

  await screen.getByRole('option', { name: /#42/ }).click();
  await expect.element(screen.getByText('Behind base')).toBeInTheDocument();
  await expect.element(screen.getByText(/base: main/)).toBeInTheDocument();
  await expect.element(screen.getByText(/2 passed/)).toBeInTheDocument();
});

describe('own-PR verdict guard', () => {
  function armCompletedRun(login: string | null) {
    mockCommands({
      viewer_login: () => login,
      list_open_prs: () => [summary({ number: 42, author: 'alice' })],
      list_pr_review_runs: () => [persistedRun({ findings: [storedFinding()] })],
      get_pr_review_run: () => persistedRun({ findings: [storedFinding()] }),
    });
  }

  test('guards exactly approve and request-changes inert on the viewer’s own PR', async () => {
    armCompletedRun('alice');
    const screen = renderView();
    await screen.getByRole('option', { name: /#42/ }).click();

    // The single open finding auto-selects on completion, so the toolbar would
    // otherwise be actionable — the own-PR guard is what makes the two verdicts
    // inert (comment, below, stays enabled, proving the selection is non-empty).

    // aria-disabled (focusable, reason via aria-describedby) — not native
    // disabled, which hides the explanation from keyboard/SR users.
    const approve = screen.getByRole('button', { name: /^approve$/i });
    const requestChanges = screen.getByRole('button', { name: /request changes/i });
    await expect.element(approve).toHaveAttribute('aria-disabled', 'true');
    await expect.element(approve).toHaveAccessibleDescription(OWN_PR_TITLE);
    await expect.element(approve).toHaveAttribute('title', OWN_PR_TITLE);
    await expect.element(requestChanges).toHaveAttribute('aria-disabled', 'true');
    await expect
      .element(requestChanges)
      .toHaveAccessibleDescription(OWN_PR_TITLE);
    await expect
      .element(screen.getByRole('button', { name: /^comment$/i }))
      .toHaveAttribute('aria-disabled', 'false');

    // The guarded click is a no-op — no ConfirmDialog opens. (`force`:
    // aria-disabled fails Playwright's actionability check; the DOM click
    // still dispatches, which is what the onClick guard must absorb.)
    await approve.click({ force: true });
    await expect
      .element(screen.getByText('Approve this pull request?'))
      .not.toBeInTheDocument();
  });

  test('fails open when the viewer login is unknown (null)', async () => {
    armCompletedRun(null);
    const screen = renderView();
    await screen.getByRole('option', { name: /#42/ }).click();
    // The finding auto-selects on completion — with the guard failing open, all
    // three verdicts are actionable.

    await expect
      .element(screen.getByRole('button', { name: /^approve$/i }))
      .toHaveAttribute('aria-disabled', 'false');
    await expect
      .element(screen.getByRole('button', { name: /request changes/i }))
      .toHaveAttribute('aria-disabled', 'false');
  });
});

test('posting still gates through the ConfirmDialog and fires only on confirm', async () => {
  mockCommands({
    list_open_prs: () => [summary({ number: 42 })],
    list_pr_review_runs: () => [persistedRun({ findings: [storedFinding()] })],
    get_pr_review_run: () => persistedRun({ findings: [storedFinding()] }),
  });
  const screen = renderView();
  await screen.getByRole('option', { name: /#42/ }).click();

  // The single open finding auto-selects on completion → the verdict toolbar is
  // actionable without a manual pick. Wait for that before firing the gate
  // (verdict buttons are aria-disabled, which Playwright's click won't await).
  const comment = screen.getByRole('button', { name: /^comment$/i });
  await expect.element(comment).toHaveAttribute('aria-disabled', 'false');
  await comment.click();
  // The human gate: nothing posted yet, the dialog names the PR + selection.
  expect(invoke.mock.calls.filter((c) => c[0] === 'post_review_to_github')).toHaveLength(0);
  await expect
    .element(screen.getByText('Post a review comment?'))
    .toBeInTheDocument();

  await screen.getByRole('button', { name: /^post comment$/i }).click();
  await vi.waitFor(() =>
    expect(
      invoke.mock.calls.filter((c) => c[0] === 'post_review_to_github'),
    ).toHaveLength(1),
  );
});

test('addressing gates through the ConfirmDialog and fires only on confirm', async () => {
  mockCommands({
    list_open_prs: () => [summary({ number: 42 })],
    list_pr_review_runs: () => [persistedRun({ findings: [storedFinding()] })],
    get_pr_review_run: () => persistedRun({ findings: [storedFinding()] }),
    address_review_findings: () => 'prfix-1',
  });
  const screen = renderView();
  await screen.getByRole('option', { name: /#42/ }).click();

  // The single open finding auto-selects on completion → Address findings (1)
  // becomes actionable without a manual pick (the button label carries the K).
  // Dispatch a native click on the element: in the headless test viewport the
  // toolbar can sit outside the scroll fold, where Playwright's coordinate-based
  // click misfires — the button itself is a normal enabled control (asserted
  // above via aria-disabled), so the native click exercises its real onClick.
  const address = screen.getByRole('button', { name: /address findings \(1\)/i });
  await expect.element(address).toHaveAttribute('aria-disabled', 'false');
  (address.element() as HTMLElement).click();
  // The human gate: nothing started yet, the dialog names PR + K + semantics.
  expect(
    invoke.mock.calls.filter((c) => c[0] === 'address_review_findings'),
  ).toHaveLength(0);
  await expect
    .element(screen.getByText('Address findings on PR #42?'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/pushing stays a separate manual step/i))
    .toBeInTheDocument();

  await screen.getByRole('button', { name: /^start fix agent$/i }).click();
  await vi.waitFor(() =>
    expect(
      invoke.mock.calls.filter((c) => c[0] === 'address_review_findings'),
    ).toHaveLength(1),
  );
  expect(
    invoke.mock.calls.find((c) => c[0] === 'address_review_findings')?.[1],
  ).toEqual({ runId: 'run-10', findingIds: ['sf1'] });
});

test('pushing a fix gates through the ConfirmDialog and fires push_pr_fix on confirm', async () => {
  mockCommands({
    list_open_prs: () => [summary({ number: 42 })],
    list_pr_review_runs: () => [persistedRun({ findings: [storedFinding()] })],
    get_pr_review_run: () => persistedRun({ findings: [storedFinding()] }),
    list_pr_fixes: () => [makeFix()],
  });
  const screen = renderView();
  await screen.getByRole('option', { name: /#42/ }).click();

  // The awaiting-push strip surfaced from the fix registry reconcile.
  await expect
    .element(screen.getByText(/handled the unwrap/i))
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /^push to pr$/i }).click();

  // The human gate: nothing pushed yet, the dialog names branch + PR.
  expect(invoke.mock.calls.filter((c) => c[0] === 'push_pr_fix')).toHaveLength(0);
  await expect
    .element(screen.getByText('Push fix to PR #42?'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/publishes the commits/i))
    .toBeInTheDocument();

  await screen.getByRole('button', { name: /^push to pr #42$/i }).click();
  await vi.waitFor(() =>
    expect(invoke.mock.calls.filter((c) => c[0] === 'push_pr_fix')).toHaveLength(1),
  );
  // The summary-comment opt-in defaults ON and rides with the push.
  expect(invoke.mock.calls.find((c) => c[0] === 'push_pr_fix')?.[1]).toEqual({
    fixId: 'prfix-1',
    postComment: true,
  });
});

test('re-review on a pushed fix starts a fresh review of the same PR', async () => {
  mockCommands({
    list_open_prs: () => [summary({ number: 42 })],
    list_pr_review_runs: () => [persistedRun({ findings: [storedFinding()] })],
    get_pr_review_run: () => persistedRun({ findings: [storedFinding()] }),
    list_pr_fixes: () => [makeFix({ status: 'pushed' })],
    start_pr_review: () => 'run-11',
  });
  const screen = renderView();
  await screen.getByRole('option', { name: /#42/ }).click();

  await screen.getByRole('button', { name: /re-review/i }).click();
  await vi.waitFor(() =>
    expect(invoke.mock.calls.filter((c) => c[0] === 'start_pr_review')).toHaveLength(1),
  );
  const args = invoke.mock.calls.find((c) => c[0] === 'start_pr_review')?.[1] as {
    prNumber: number;
    lenses: string[];
  };
  expect(args.prNumber).toBe(42);
  expect(args.lenses.length).toBeGreaterThan(0);
});

test('renders the PR Review header for an active project', async () => {
  const screen = render(<Idle />);
  await expect
    .element(screen.getByRole('heading', { name: 'PR Review' }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('acme')).toBeInTheDocument();
});

test('shows the empty state when no project is active', async () => {
  const screen = render(<NoProject />);
  await expect.element(screen.getByText('No active project')).toBeInTheDocument();
});
