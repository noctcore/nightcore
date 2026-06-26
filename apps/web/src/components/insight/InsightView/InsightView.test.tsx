import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
import * as stories from './InsightView.stories';

const { Idle, NoProject } = composeStories(stories);

test('renders the Insight header for an active project', async () => {
  const screen = render(<Idle />);
  await expect.element(screen.getByRole('heading', { name: 'Insight' })).toBeInTheDocument();
  await expect.element(screen.getByText('acme')).toBeInTheDocument();
});

test('offers the Analyze control in the idle project view', async () => {
  const screen = render(<Idle />);
  await expect.element(screen.getByRole('button', { name: /^analyze$/i })).toBeInTheDocument();
});

test('shows the empty state when no project is active', async () => {
  const screen = render(<NoProject />);
  await expect.element(screen.getByText('No active project')).toBeInTheDocument();
});
