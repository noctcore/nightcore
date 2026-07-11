import { userEvent } from '@vitest/browser/context';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Spy only the chip's ONE bridge dependency (the browser open); everything else — the
// `makeTask` fixture's type imports and the board fixtures — keeps its real module.
const openIssueInBrowser = vi.fn<(issueNumber: number) => Promise<void>>();
vi.mock('@/lib/bridge', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/bridge')>();
  return { ...actual, openIssueInBrowser: (n: number) => openIssueInBrowser(n) };
});

import { makeTask } from '../_fixtures.task';
import { IssueClosedChip } from './IssueClosedChip';

afterEach(() => openIssueInBrowser.mockReset());

test('renders the chip and opens the issue on click for a closed non-terminal task', async () => {
  openIssueInBrowser.mockResolvedValue();
  const task = makeTask({ status: 'in_progress', issueNumber: 128, issueState: 'closed' });
  const screen = render(<IssueClosedChip task={task} />);

  const chip = screen.getByRole('button', {
    name: 'Issue #128 closed upstream — open it on GitHub',
  });
  await expect.element(chip).toBeInTheDocument();

  await userEvent.click(chip);
  // Clicking OPENS the issue (read-only) — it never dispatches a task mutation.
  expect(openIssueInBrowser).toHaveBeenCalledTimes(1);
  expect(openIssueInBrowser).toHaveBeenCalledWith(128);
});

test('renders nothing when the linked issue is still open', () => {
  const task = makeTask({ status: 'in_progress', issueNumber: 128, issueState: 'open' });
  const screen = render(<IssueClosedChip task={task} />);
  expect(screen.container.querySelector('button')).toBeNull();
});

test('renders nothing once the task is Done (a closed issue is then expected)', () => {
  const task = makeTask({ status: 'done', issueNumber: 128, issueState: 'closed' });
  const screen = render(<IssueClosedChip task={task} />);
  expect(screen.container.querySelector('button')).toBeNull();
});

test('renders nothing for a merged task even if the issue is closed', () => {
  const task = makeTask({
    status: 'in_progress',
    issueNumber: 128,
    issueState: 'closed',
    merged: true,
  });
  const screen = render(<IssueClosedChip task={task} />);
  expect(screen.container.querySelector('button')).toBeNull();
});

test('renders nothing when the task links no issue', () => {
  const task = makeTask({ status: 'in_progress', issueState: 'closed' });
  const screen = render(<IssueClosedChip task={task} />);
  expect(screen.container.querySelector('button')).toBeNull();
});
