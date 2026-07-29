import { userEvent } from '@vitest/browser/context';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Spy only the chip's ONE bridge dependency (the browser open); everything else keeps its
// real module (mirrors the IssueClosedChip test).
const openIssueInBrowser = vi.fn<(issueNumber: number) => Promise<void>>();
vi.mock('@/lib/bridge', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/bridge')>();
  return { ...actual, openIssueInBrowser: (n: number) => openIssueInBrowser(n) };
});

import { makeTask } from '../_fixtures.task';
import { IssueChip } from './IssueChip';

afterEach(() => openIssueInBrowser.mockReset());

test('renders the chip and opens the linked issue on click', async () => {
  openIssueInBrowser.mockResolvedValue();
  const screen = render(<IssueChip task={makeTask({ issueNumber: 402 })} />);

  const chip = screen.getByRole('button', { name: 'Issue #402 — open it on GitHub' });
  await expect.element(chip).toBeInTheDocument();
  await expect.element(chip).toHaveTextContent('issue #402');

  await userEvent.click(chip);
  // Read-only, exactly like the PR chip: it opens the issue and mutates nothing.
  expect(openIssueInBrowser).toHaveBeenCalledTimes(1);
  expect(openIssueInBrowser).toHaveBeenCalledWith(402);
});

test('is keyboard reachable and activates on Enter', async () => {
  openIssueInBrowser.mockResolvedValue();
  const screen = render(<IssueChip task={makeTask({ issueNumber: 7 })} />);
  const chip = screen.getByRole('button', { name: 'Issue #7 — open it on GitHub' });
  await expect.element(chip).toBeInTheDocument();

  await userEvent.keyboard('{Tab}');
  await userEvent.keyboard('{Enter}');
  expect(openIssueInBrowser).toHaveBeenCalledWith(7);
});

test('renders nothing when the task links no issue', () => {
  const screen = render(<IssueChip task={makeTask()} />);
  expect(screen.container.querySelector('button')).toBeNull();
});

test('yields to the closed-upstream chip while the issue diverges', () => {
  // Exactly one issue chip renders: the louder warning chip owns this state.
  const screen = render(
    <IssueChip
      task={makeTask({ status: 'in_progress', issueNumber: 402, issueState: 'closed' })}
    />,
  );
  expect(screen.container.querySelector('button')).toBeNull();
});

test('keeps the provenance chip on a Done task whose issue closed upstream', async () => {
  const screen = render(
    <IssueChip task={makeTask({ status: 'done', issueNumber: 402, issueState: 'closed' })} />,
  );
  await expect
    .element(screen.getByRole('button', { name: 'Issue #402 — open it on GitHub' }))
    .toBeInTheDocument();
});
