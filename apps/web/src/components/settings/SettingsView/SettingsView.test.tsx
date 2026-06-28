import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './SettingsView.stories';

const { Global, NoActiveProject } = composeStories(stories);

test('updates a global setting with the SDK long id when scope is Global', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  await screen.getByRole('button', { name: 'Sonnet' }).click();
  // The persisted value is the SDK long id, not the short label.
  expect(onUpdate).toHaveBeenCalledWith({ defaultModel: 'claude-sonnet-4-6' });
});

test('commits a Max-turns ceiling as a global guardrail patch', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  const input = screen.getByRole('spinbutton', { name: 'Max turns' });
  await input.fill('120');
  // Commit on blur (Enter or focus-out).
  await screen.getByRole('spinbutton', { name: 'Max budget in USD' }).click();
  expect(onUpdate).toHaveBeenCalledWith({ maxTurns: 120 });
});

test('routes a Max-budget ceiling to a project override under the project scope', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  await screen.getByRole('button', { name: 'nightcore' }).click();
  const input = screen.getByRole('spinbutton', { name: 'Max budget in USD' });
  await input.fill('2.5');
  await screen.getByRole('spinbutton', { name: 'Max turns' }).click();
  expect(onUpdate).toHaveBeenCalledWith({ maxBudgetUsd: 2.5, projectId: 'nightcore' });
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
