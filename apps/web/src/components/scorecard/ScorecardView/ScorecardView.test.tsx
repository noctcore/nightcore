import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ScorecardView.stories';

const { Idle, NoProject } = composeStories(stories);

test('renders the Scorecard header for an active project', async () => {
  const screen = render(<Idle />);
  await expect
    .element(screen.getByRole('heading', { name: 'Scorecard' }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('acme')).toBeInTheDocument();
});

test('shows the CONFIGURE screen with the Grade control when idle', async () => {
  const screen = render(<Idle />);
  await expect.element(screen.getByText('Run config')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /grade readiness/i }))
    .toBeInTheDocument();
});

test('shows the empty state when no project is active', async () => {
  const screen = render(<NoProject />);
  await expect.element(screen.getByText('No active project')).toBeInTheDocument();
});
