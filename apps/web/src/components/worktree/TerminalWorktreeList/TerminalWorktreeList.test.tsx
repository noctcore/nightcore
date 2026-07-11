import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './TerminalWorktreeList.stories';

const { Default, Empty } = composeStories(stories);

test('lists the terminal worktrees under the group heading', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByRole('heading', { name: 'Terminal worktrees' }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('term/spike-auth')).toBeInTheDocument();
  await expect.element(screen.getByText('term/scratch')).toBeInTheDocument();
});

test('shows a changed chip only for a dirty worktree', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('3 changed')).toBeInTheDocument();
});

test('open-terminal fires with the worktree path', async () => {
  const onOpenTerminal = vi.fn();
  const screen = render(<Default onOpenTerminal={onOpenTerminal} />);
  await screen.getByRole('button', { name: /Terminal/ }).first().click();
  expect(onOpenTerminal).toHaveBeenCalledWith(
    '/Users/dev/nightcore/.nightcore/worktrees-term/spike-auth',
  );
});

test('discard fires with the worktree', async () => {
  const onDiscard = vi.fn();
  const screen = render(<Default onDiscard={onDiscard} />);
  await screen.getByRole('button', { name: /Discard/ }).first().click();
  expect(onDiscard).toHaveBeenCalledWith(
    expect.objectContaining({ branch: 'term/spike-auth' }),
  );
});

test('renders nothing when there are no terminal worktrees', () => {
  const { container } = render(<Empty />);
  expect(container.textContent).toBe('');
});
