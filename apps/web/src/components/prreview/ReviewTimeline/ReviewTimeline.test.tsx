import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ReviewTimeline.stories';

const { ReviewedPendingPost, FullArc, FixRunning, SingleNodeHidden } =
  composeStories(stories);

test('renders the reviewed → pending-post arc with a timestamp', async () => {
  const screen = render(<ReviewedPendingPost />);
  await expect.element(screen.getByText('Review timeline')).toBeInTheDocument();
  await expect.element(screen.getByText('Reviewed')).toBeInTheDocument();
  await expect.element(screen.getByText('Pending post')).toBeInTheDocument();
});

test('the full arc shows the posted + fix-pushed + re-review nodes', async () => {
  const screen = render(<FullArc />);
  await expect.element(screen.getByText('Posted to GitHub')).toBeInTheDocument();
  await expect.element(screen.getByText('Fix pushed')).toBeInTheDocument();
  await expect.element(screen.getByText(/re-review/i)).toBeInTheDocument();
});

test('a running fix shows the live fix node', async () => {
  const screen = render(<FixRunning />);
  await expect.element(screen.getByText('Fix running')).toBeInTheDocument();
});

test('a single node renders nothing (no arc)', async () => {
  const screen = render(<SingleNodeHidden />);
  expect(screen.container.textContent).not.toContain('Review timeline');
});

test('the live arc node is programmatically exposed with aria-current="step"', async () => {
  const screen = render(<FixRunning />);
  // The running fix is the current position; a screen reader can find it via
  // aria-current rather than inferring from color alone.
  const current = screen.container.querySelector('li[aria-current="step"]');
  expect(current).not.toBeNull();
  expect(current?.textContent).toContain('Fix running');
});
