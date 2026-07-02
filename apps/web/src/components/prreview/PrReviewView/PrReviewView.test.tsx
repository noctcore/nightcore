import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './PrReviewView.stories';

const { Idle, NoProject } = composeStories(stories);

test('renders the PR Review header for an active project', async () => {
  const screen = render(<Idle />);
  await expect
    .element(screen.getByRole('heading', { name: 'PR Review' }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('acme')).toBeInTheDocument();
});

test('shows the CONFIGURE screen with the Review control when idle', async () => {
  const screen = render(<Idle />);
  await expect.element(screen.getByText('Run config')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /^review pr$/i }))
    .toBeInTheDocument();
});

test('shows the empty state when no project is active', async () => {
  const screen = render(<NoProject />);
  await expect.element(screen.getByText('No active project')).toBeInTheDocument();
});
