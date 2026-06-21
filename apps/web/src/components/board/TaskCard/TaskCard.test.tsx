import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './TaskCard.stories';

const { Failed, Done } = composeStories(stories);

test('shows the error line on a failed task', async () => {
  const screen = render(<Failed />);
  await expect
    .element(screen.getByText("cannot resolve 'sass-loader'"))
    .toBeInTheDocument();
});

test('calls onSelect with the task id when clicked', async () => {
  const onSelect = vi.fn();
  const screen = render(<Done onSelect={onSelect} />);
  await screen.getByRole('button', { name: /wire up auth guard/i }).click();
  expect(onSelect).toHaveBeenCalledWith('t-done');
});
