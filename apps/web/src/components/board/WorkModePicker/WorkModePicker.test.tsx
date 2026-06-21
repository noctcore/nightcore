import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './WorkModePicker.stories';

const { Main, Worktree, Disabled } = composeStories(stories);

test('marks the selected mode as checked', async () => {
  const screen = render(<Main />);
  await expect
    .element(screen.getByRole('radio', { name: /main/i }))
    .toHaveAttribute('aria-checked', 'true');
});

test('fires onChange with the picked mode', async () => {
  const onChange = vi.fn();
  const screen = render(<Worktree onChange={onChange} />);
  await screen.getByRole('radio', { name: /main/i }).click();
  expect(onChange).toHaveBeenCalledWith('main');
});

test('disables both options when disabled', async () => {
  const screen = render(<Disabled />);
  await expect.element(screen.getByRole('radio', { name: /main/i })).toBeDisabled();
  await expect.element(screen.getByRole('radio', { name: /worktree/i })).toBeDisabled();
});

test('shows the explainer for the selected mode', async () => {
  const screen = render(<Worktree />);
  await expect
    .element(screen.getByText(/isolates this task on its own branch/i))
    .toBeInTheDocument();
});
