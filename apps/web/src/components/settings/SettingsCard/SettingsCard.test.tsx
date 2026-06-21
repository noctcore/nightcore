import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
import * as stories from './SettingsCard.stories';

const { Models, WithRoadmapBadge } = composeStories(stories);

test('renders the card title and its rows', async () => {
  const screen = render(<Models />);
  await expect.element(screen.getByText('Models')).toBeInTheDocument();
  await expect.element(screen.getByText('Default model')).toBeInTheDocument();
  await expect.element(screen.getByText('Reasoning effort')).toBeInTheDocument();
});

test('shows the roadmap badge when provided', async () => {
  const screen = render(<WithRoadmapBadge />);
  await expect.element(screen.getByText('M2')).toBeInTheDocument();
});
