import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './ReviewPanel.stories';
import { deriveReviewPanelView } from './ReviewPanel.hooks';
import { SAMPLE_REVIEW_CHANGES, makeTask } from '../_fixtures';

const { ParkedChangesRequested, Passed, Unparseable, StructureLockParked } =
  composeStories(stories);

test('renders the verdict label and reviewer text for changes requested', async () => {
  const screen = render(<ParkedChangesRequested />);
  await expect.element(screen.getByText('Changes requested')).toBeInTheDocument();
  await expect
    .element(screen.getByText(/violate the NOT NULL constraint/))
    .toBeInTheDocument();
});

test('surfaces the exhausted auto-fix budget note', async () => {
  const screen = render(<ParkedChangesRequested />);
  await expect.element(screen.getByText(/Auto-fix budget exhausted/)).toBeInTheDocument();
});

test('shows no actions for an already-verified passed task', async () => {
  const screen = render(<Passed />);
  await expect.element(screen.getByText('Passed')).toBeInTheDocument();
  expect(screen.container.querySelectorAll('button')).toHaveLength(0);
});

test('treats a missing verdict line as fail-safe', async () => {
  const screen = render(<Unparseable />);
  await expect.element(screen.getByText(/treated as fail/i)).toBeInTheDocument();
});

test('shows the structure-lock alert naming the failed check even with no review', async () => {
  const screen = render(<StructureLockParked />);
  await expect.element(screen.getByText('Structure lock failed')).toBeInTheDocument();
  await expect.element(screen.getByText('folder-per-component')).toBeInTheDocument();
});

test('fires onReject when Reject is clicked on a parked verification', async () => {
  const onReject = vi.fn();
  const screen = render(<ParkedChangesRequested onReject={onReject} />);
  await screen.getByRole('button', { name: 'Reject' }).click();
  expect(onReject).toHaveBeenCalledWith('t-waiting');
});

test('deriveReviewPanelView parses the verdict and gates actions on the status', () => {
  const parked = deriveReviewPanelView(
    makeTask({ status: 'waiting_approval', review: SAMPLE_REVIEW_CHANGES, fixAttempts: 2 }),
  );
  expect(parked.verdict).toBe('CHANGES_REQUESTED');
  expect(parked.budgetExhausted).toBe(true);
  expect(parked.showActions).toBe(true);

  const done = deriveReviewPanelView(
    makeTask({ status: 'done', review: 'VERDICT: PASS', verified: true }),
  );
  expect(done.verdict).toBe('PASS');
  expect(done.showActions).toBe(false);
});
