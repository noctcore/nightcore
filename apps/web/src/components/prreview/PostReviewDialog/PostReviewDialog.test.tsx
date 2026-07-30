import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './PostReviewDialog.stories';

const { PrefilledFromClamp, HumanOverrodeTheVerdict, LowsOnly, PostFailed, Closed } =
  composeStories(stories);

test('opens PRE-FILLED on the clamped verdict and says where it came from', async () => {
  const screen = render(<PrefilledFromClamp />);
  await expect
    .element(screen.getByText('Request changes on this pull request?'))
    .toBeInTheDocument();
  await expect.element(screen.getByText('Pre-filled', { exact: true })).toBeInTheDocument();
  // The clamp reason rides along, so the recommendation is never a black box.
  await expect.element(screen.getByText(/floors the verdict/)).toBeInTheDocument();
});

test('names the recommendation when the human armed a different verdict', async () => {
  const screen = render(<HumanOverrodeTheVerdict />);
  await expect.element(screen.getByText('Post a review comment?')).toBeInTheDocument();
  await expect
    .element(screen.getByText(/^Recommended:/))
    .toHaveTextContent('Recommended: Request changes');
});

test('shows the PRE-SELECTED inline / body split', async () => {
  const screen = render(<PrefilledFromClamp />);
  await expect
    .element(screen.getByText(/inline comments ·/))
    .toHaveTextContent('3 inline comments · 6 in the review body');
});

test('a lows-only review pre-fills a non-blocking comment with nothing inline', async () => {
  const screen = render(<LowsOnly />);
  await expect.element(screen.getByText('Post a review comment?')).toBeInTheDocument();
  await expect.element(screen.getByText(/Pre-filled/)).toBeInTheDocument();
  await expect
    .element(screen.getByText(/inline comments ·/))
    .toHaveTextContent('0 inline comments · 11 in the review body');
});

test('the verdict selector EDITS the pre-fill (re-arms; never posts)', async () => {
  const screen = render(<PrefilledFromClamp />);
  const post = PrefilledFromClamp.args.post!;
  await screen
    .getByRole('group', { name: 'Review verdict' })
    .getByRole('button', { name: 'Approve', exact: true })
    .click();
  expect(post.requestPost).toHaveBeenCalledWith('approve');
  // Re-arming is NOT posting.
  expect(post.confirmPost).not.toHaveBeenCalled();
});

test('the split toggle edits which findings go inline', async () => {
  const screen = render(<PrefilledFromClamp />);
  const post = PrefilledFromClamp.args.post!;
  await screen.getByText(/every anchorable finding inline/i).click();
  expect(post.setPostAllInline).toHaveBeenCalledWith(true);
  expect(post.confirmPost).not.toHaveBeenCalled();
});

test('NEVER posts without an explicit human confirmation', async () => {
  const screen = render(<LowsOnly />);
  const post = LowsOnly.args.post!;
  // Rendering an armed, fully pre-filled gate posts nothing on its own.
  await expect.element(screen.getByText('Post a review comment?')).toBeInTheDocument();
  expect(post.confirmPost).not.toHaveBeenCalled();
  // Only the confirm button reaches the post.
  await screen.getByRole('button', { name: 'Post comment', exact: true }).click();
  expect(post.confirmPost).toHaveBeenCalledTimes(1);
});

test('a failed post keeps the gate open with the error inline', async () => {
  const screen = render(<PostFailed />);
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('anchor outside the diff');
});

test('renders nothing when no verdict is armed', () => {
  const screen = render(<Closed />);
  expect(screen.container.textContent).toBe('');
});
