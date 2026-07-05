import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ReviewPosition } from './ReviewPosition';
import * as stories from './ReviewPosition.stories';

const {
  ReadyVerdict,
  BlockedVerdict,
  Reconciliation,
  Stale,
  Followup,
  Empty,
} = composeStories(stories);

test('renders the merge verdict badge and toggles its reasoning', async () => {
  const screen = render(<ReadyVerdict />);
  await expect
    .element(screen.getByText('Ready to merge', { exact: true }))
    .toBeInTheDocument();
  // The reasoning is collapsed until asked for.
  await expect
    .element(screen.getByText(/well-tested/i))
    .not.toBeInTheDocument();
  await screen.getByRole('button', { name: /why this verdict/i }).click();
  await expect.element(screen.getByText(/well-tested/i)).toBeInTheDocument();
});

test('a blocked verdict renders its badge', async () => {
  const screen = render(<BlockedVerdict />);
  await expect.element(screen.getByText('Blocked', { exact: true })).toBeInTheDocument();
});

test('the reconciliation banner names each contradiction and nudges a re-review', async () => {
  const onReReview = vi.fn();
  const screen = render(<Reconciliation onReReview={onReReview} />);
  await expect
    .element(screen.getByText(/verdict may be out of date/i))
    .toBeInTheDocument();
  await expect.element(screen.getByText('2 checks failing')).toBeInTheDocument();
  await expect
    .element(screen.getByText('Branch is behind the base'))
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /re-review the pr/i }).click();
  expect(onReReview).toHaveBeenCalledOnce();
});

test('the staleness chip shows the branch-moved message with a re-review nudge', async () => {
  const onReReview = vi.fn();
  const screen = render(<Stale onReReview={onReReview} />);
  await expect
    .element(screen.getByText(/branch has moved since this review/i))
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /^re-review$/i }).click();
  expect(onReReview).toHaveBeenCalledOnce();
});

test('the reconciliation banner and staleness chip are polite live regions', async () => {
  // Both are async-derived from the lifted PR status, so they must announce when
  // the contradicting status lands rather than appearing silently (role=status).
  const recon = render(<Reconciliation onReReview={vi.fn()} />);
  await expect
    .element(recon.getByText(/verdict may be out of date/i))
    .toBeInTheDocument();
  expect(recon.container.querySelector('[role="status"]')).not.toBeNull();

  const stale = render(<Stale onReReview={vi.fn()} />);
  await expect
    .element(stale.getByText(/branch has moved since this review/i))
    .toBeInTheDocument();
  expect(stale.container.querySelector('[role="status"]')).not.toBeNull();
});

test('the follow-up summary reports resolved / still-open / new counts', async () => {
  const screen = render(<Followup />);
  await expect.element(screen.getByText('4 resolved')).toBeInTheDocument();
  await expect.element(screen.getByText('2 still open')).toBeInTheDocument();
  await expect.element(screen.getByText('1 new')).toBeInTheDocument();
});

test('renders nothing when there is no position to show', async () => {
  const screen = render(<Empty />);
  // No verdict badge, banner, chip, or summary — the container is empty.
  await expect.element(screen.getByText(/verdict/i)).not.toBeInTheDocument();
  await expect
    .element(screen.getByText(/branch has moved/i))
    .not.toBeInTheDocument();
});

test('absent verdict renders no badge but still shows other signals', async () => {
  const screen = render(
    <ReviewPosition
      verdict={null}
      verdictReasoning={null}
      reconciliation={[]}
      stale
      followup={null}
      onReReview={vi.fn()}
    />,
  );
  await expect
    .element(screen.getByText(/branch has moved since this review/i))
    .toBeInTheDocument();
  // An unknown/absent verdict never renders a merge badge.
  await expect.element(screen.getByText(/ready to merge/i)).not.toBeInTheDocument();
});
