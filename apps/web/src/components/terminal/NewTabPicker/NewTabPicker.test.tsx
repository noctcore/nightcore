import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './NewTabPicker.stories';

const { Default, Empty, CapReached, Busy } = composeStories(stories);

test('lists the repo root and worktrees as pickable targets', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByRole('heading', { name: 'Open a terminal' })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /nightcore/ }).first()).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /nc\/task-42/ })).toBeInTheDocument();
});

test('picking a target fires onPick with its absolute path', async () => {
  const onPick = vi.fn();
  const screen = render(<Default onPick={onPick} />);
  await screen.getByRole('button', { name: /nc\/task-91/ }).click();
  expect(onPick).toHaveBeenCalledWith('/Users/dev/nightcore/.nightcore/worktrees/task-91');
});

test('shows an empty note when no project is open', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/No open project — open a project to start a terminal/i))
    .toBeInTheDocument();
});

test('surfaces the session-cap error inline without closing', async () => {
  const onClose = vi.fn();
  const screen = render(<CapReached onClose={onClose} />);
  await expect
    .element(screen.getByText(/terminal session limit reached \(8\)/i))
    .toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

test('disables targets while a spawn is in flight', async () => {
  const screen = render(<Busy />);
  await expect.element(screen.getByRole('button', { name: /nc\/task-42/ })).toBeDisabled();
});
