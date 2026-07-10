import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './TerminalReadonlyPane.stories';

const { Restorable, Vanished } = composeStories(stories);

test('renders the read-only "session ended" chrome with the shell + cwd', async () => {
  const screen = render(<Restorable />);
  await expect.element(screen.getByText('Session ended — read-only')).toBeInTheDocument();
  await expect
    .element(screen.getByText('/Users/dev/nightcore/.nightcore/worktrees/task-42'))
    .toBeInTheDocument();
});

test('the fresh-shell action is enabled and fires onRestore when the folder exists', async () => {
  const onRestore = vi.fn();
  const screen = render(<Restorable onRestore={onRestore} />);
  const action = screen.getByRole('button', { name: /Start a fresh shell here/i });
  await expect.element(action).toBeEnabled();
  await action.click();
  expect(onRestore).toHaveBeenCalled();
});

test('the fresh-shell action is disabled with a hint when the folder is gone', async () => {
  const screen = render(<Vanished />);
  await expect
    .element(screen.getByRole('button', { name: /Start a fresh shell here/i }))
    .toBeDisabled();
  await expect
    .element(screen.getByText(/its original folder is no longer available/i))
    .toBeInTheDocument();
});
