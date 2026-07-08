import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Sidebar.stories';

const { Unified, Classic } = composeStories(stories);

test('Unified mode renders the project switcher', async () => {
  const screen = render(<Unified />);
  await expect.element(screen.getByTitle('nightcore')).toBeInTheDocument();
});

test('Classic mode renders the project rail without unified header brand row', async () => {
  const screen = render(<Classic />);
  await expect
    .element(screen.getByRole('complementary', { name: 'Projects' }))
    .toBeInTheDocument();
});

test('navigates when a nav item is clicked', async () => {
  const onNavigate = vi.fn();
  const screen = render(<Unified onNavigate={onNavigate} />);
  await screen.getByText('Kanban Board').click();
  expect(onNavigate).toHaveBeenCalledWith('board');
});
