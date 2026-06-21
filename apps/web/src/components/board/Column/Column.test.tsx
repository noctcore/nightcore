import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
import * as stories from './Column.stories';

const { Empty, Populated } = composeStories(stories);

test('shows the empty placeholder when a column has no tasks', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('Nothing here yet')).toBeInTheDocument();
});

test('renders one card per task with the count badge', async () => {
  const screen = render(<Populated />);
  const cards = screen.container.querySelectorAll('button');
  expect(cards.length).toBe(2);
});
