import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { FIX_RUNNING_TITLE, OWN_PR_TITLE } from './ReviewSection.hooks';
import * as stories from './ReviewSection.stories';
import type { ReviewSectionToolbarSlice } from './ReviewSection.types';

/** A full toolbar slice for prop-override tests (the stories keep their own). */
function toolbarSlice(
  over: Partial<ReviewSectionToolbarSlice> = {},
): ReviewSectionToolbarSlice {
  return {
    openCount: 2,
    onConvertAll: vi.fn(),
    bulkConverting: false,
    bulkProgress: { done: 0, total: 0, failed: 0 },
    bulkStatusMessage: '',
    bulkError: null,
    selectedCount: 1,
    canPost: true,
    requestPost: vi.fn(),
    ownPr: false,
    postedFeedback: null,
    addressCount: 1,
    canAddress: true,
    fixRunning: false,
    requestAddress: vi.fn(),
    addressError: null,
    ...over,
  };
}

const {
  Config,
  ConfigWithStartError,
  Running,
  Completed,
  CompletedOwnPr,
  ViewingPastRun,
  CompletedNothingSelected,
  CompletedFixRunning,
  CompletedFixAwaitingPush,
  CompletedWithTimeline,
  CompletedJustPosted,
  CompletedClean,
} = composeStories(stories);

test('config mode renders the lens chips and the Review action', async () => {
  const screen = render(<Config />);
  await expect
    .element(screen.getByRole('button', { name: /^security$/i }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /^review pr #128$/i }))
    .toBeEnabled();
});

test('config mode surfaces the per-PR start error', async () => {
  const screen = render(<ConfigWithStartError />);
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent(/no pull request found for #128/i);
});

test('running mode renders the lens progress and the cancel action', async () => {
  const screen = render(<Running />);
  await expect
    .element(screen.getByRole('button', { name: /cancel review/i }))
    .toBeInTheDocument();
  // The two requested lenses render as progress rows.
  await expect.element(screen.getByText('Security')).toBeInTheDocument();
  await expect.element(screen.getByText('Logic')).toBeInTheDocument();
});

test('results mode renders the toolbar with all three verdicts enabled', async () => {
  const screen = render(<Completed />);
  await expect
    .element(screen.getByRole('button', { name: /^approve$/i }))
    .toHaveAttribute('aria-disabled', 'false');
  await expect
    .element(screen.getByRole('button', { name: /request changes/i }))
    .toHaveAttribute('aria-disabled', 'false');
  await expect
    .element(screen.getByRole('button', { name: /^comment$/i }))
    .toHaveAttribute('aria-disabled', 'false');
  await expect
    .element(screen.getByRole('button', { name: /convert all to tasks \(2\)/i }))
    .toBeInTheDocument();
});

test('the own-PR guard makes exactly approve and request-changes inert, with the reason reachable by keyboard/SR', async () => {
  const requestPost = vi.fn();
  const screen = render(
    <CompletedOwnPr toolbar={toolbarSlice({ requestPost })} />,
  );
  const approve = screen.getByRole('button', { name: /^approve$/i });
  const requestChanges = screen.getByRole('button', { name: /request changes/i });
  // aria-disabled (NOT native disabled): the buttons stay focusable and the
  // guard reason rides via aria-describedby → the sr-only reason span.
  await expect.element(approve).toHaveAttribute('aria-disabled', 'true');
  await expect.element(approve).toHaveAccessibleDescription(OWN_PR_TITLE);
  await expect.element(approve).toHaveAttribute('title', OWN_PR_TITLE);
  await expect.element(requestChanges).toHaveAttribute('aria-disabled', 'true');
  await expect
    .element(requestChanges)
    .toHaveAccessibleDescription(OWN_PR_TITLE);
  // The guarded onClick is a no-op — clicking never opens the ConfirmDialog.
  // (`force`: Playwright's actionability check refuses aria-disabled targets,
  // but the DOM click still dispatches — exactly what the guard must absorb.)
  await approve.click({ force: true });
  await requestChanges.click({ force: true });
  expect(requestPost).not.toHaveBeenCalled();
  // Comment is NOT guarded — posting as comment is the sanctioned path.
  const comment = screen.getByRole('button', { name: /^comment$/i });
  await expect.element(comment).toHaveAttribute('aria-disabled', 'false');
  await comment.click();
  expect(requestPost).toHaveBeenCalledWith('comment');
});

test('a history selection shows the past-run affordance with a way back', async () => {
  const screen = render(<ViewingPastRun />);
  await expect
    .element(screen.getByText(/viewing a past review run/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /back to latest/i }))
    .toBeInTheDocument();
});

test('the address action names the OPEN selection count and is enabled beside convert-all', async () => {
  const screen = render(<Completed />);
  await expect
    .element(screen.getByRole('button', { name: /address findings \(1\)/i }))
    .toBeEnabled();
});

test('the address action goes inert when nothing is selected', async () => {
  const screen = render(<CompletedNothingSelected />);
  await expect
    .element(screen.getByRole('button', { name: /address findings \(0\)/i }))
    .toHaveAttribute('aria-disabled', 'true');
});

test('the address action goes inert while a fix runs, with the reason reachable by keyboard/SR', async () => {
  const requestAddress = vi.fn();
  const screen = render(
    <CompletedFixRunning
      toolbar={toolbarSlice({ canAddress: false, fixRunning: true, requestAddress })}
    />,
  );
  const address = screen.getByRole('button', { name: /address findings/i });
  // aria-disabled + describedby reason (the convert-all precedent), title kept
  // for mouse hover; the guarded onClick never opens the ConfirmDialog.
  await expect.element(address).toHaveAttribute('aria-disabled', 'true');
  await expect.element(address).toHaveAccessibleDescription(FIX_RUNNING_TITLE);
  await expect.element(address).toHaveAttribute('title', FIX_RUNNING_TITLE);
  // `force`: aria-disabled fails Playwright's actionability check; the DOM
  // click still dispatches, which is what the onClick guard must absorb.
  await address.click({ force: true });
  expect(requestAddress).not.toHaveBeenCalled();
  // The per-PR fix strip renders inside the results stack.
  await expect
    .element(screen.getByText('Addressing 3 findings on fix/token-logging'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /cancel fix/i }))
    .toBeInTheDocument();
});

test('the persistent status live region tracks the section mode', async () => {
  const running = render(<Running />);
  await expect
    .element(running.getByText('Review running', { exact: true }))
    .toBeInTheDocument();
  running.unmount();

  // Completed: the region announces the finding count of the displayed run.
  const completed = render(<Completed />);
  await expect
    .element(completed.getByText('Review completed, 2 findings', { exact: true }))
    .toBeInTheDocument();
  completed.unmount();

  // Config: the region is present but silent (empty).
  const config = render(<Config />);
  await expect
    .element(config.getByText('Review running', { exact: true }))
    .not.toBeInTheDocument();
});

test('an awaiting-push fix renders its summary and the push affordance in results', async () => {
  const screen = render(<CompletedFixAwaitingPush />);
  await expect
    .element(screen.getByText(/redacted the session token/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /^push to pr$/i }))
    .toBeEnabled();
  // Addressing stays available for a NEW selection while one awaits push.
  await expect
    .element(screen.getByRole('button', { name: /address findings \(1\)/i }))
    .toBeEnabled();
});

test('the review-arc timeline renders atop the completed results', async () => {
  const screen = render(<CompletedWithTimeline />);
  await expect.element(screen.getByText('Review timeline')).toBeInTheDocument();
  await expect.element(screen.getByText('Posted to GitHub')).toBeInTheDocument();
});

test('a successful post shows the auto-clearing "Posted N findings" confirmation', async () => {
  const screen = render(<CompletedJustPosted />);
  await expect
    .element(screen.getByText(/posted 2 findings/i))
    .toBeInTheDocument();
});

test('a completed clean run shows the celebratory positive empty state', async () => {
  const screen = render(<CompletedClean />);
  await expect
    .element(screen.getByText('No findings', { exact: true }))
    .toBeInTheDocument();
});
