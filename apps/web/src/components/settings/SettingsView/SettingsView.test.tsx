import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './SettingsView.stories';

const { Global, NoActiveProject } = composeStories(stories);

test('updates a global setting with the SDK long id when scope is Global', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  await screen.getByRole('button', { name: 'Sonnet' }).click();
  // P0: the persisted value is the SDK long id, not the short label.
  expect(onUpdate).toHaveBeenCalledWith({ defaultModel: 'claude-sonnet-4-6' });
});

test('routes the patch to a project override under the project scope', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  // Switch to the per-project scope (tab labelled with the project name).
  await screen.getByRole('button', { name: 'nightcore' }).click();
  await screen.getByRole('button', { name: 'Opus' }).click();
  expect(onUpdate).toHaveBeenCalledWith({
    defaultModel: 'claude-opus-4-8',
    projectId: 'nightcore',
  });
});

test('makes the worktree cleanup toggle editable and global-only', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  await screen.getByRole('button', { name: /git worktrees/i }).click();
  await screen.getByRole('switch', { name: /delete worktree on complete/i }).click();
  // cleanupWorktrees is global by design — no projectId even from a default story
  // that has an active project.
  expect(onUpdate).toHaveBeenCalledWith({ cleanupWorktrees: false });
});

test('surfaces the default run mode selector and routes it scoped', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  await screen.getByRole('button', { name: /git worktrees/i }).click();
  await screen.getByRole('button', { name: 'Worktree', exact: true }).click();
  expect(onUpdate).toHaveBeenCalledWith({ defaultRunMode: 'worktree' });
});

test('disables the project scope tab when no project is active', async () => {
  const screen = render(<NoActiveProject />);
  await expect.element(screen.getByText('This project')).toBeDisabled();
});

test('navigates between settings pages via the left nav', async () => {
  const screen = render(<Global />);
  await screen.getByRole('button', { name: /permissions/i }).click();
  await expect.element(screen.getByText('Tool permissions')).toBeInTheDocument();
});
