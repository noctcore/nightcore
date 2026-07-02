import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './DetailCardGrid.stories';

const { WithCards, Streaming, Empty } = composeStories(stories);

test('renders its card children', async () => {
  const screen = render(<WithCards />);
  await expect.element(screen.getByText('An example finding')).toBeInTheDocument();
});

test('marks the grid busy while streaming skeleton cards', async () => {
  const screen = render(<Streaming />);
  expect(screen.container.querySelector('[aria-busy="true"]')).not.toBeNull();
});

test('shows the empty message when there is nothing to render', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('Nothing to show yet.')).toBeInTheDocument();
});
