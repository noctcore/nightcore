import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './SettingsView.stories';

const { Global, NoActiveProject } = composeStories(stories);

test('updates a global setting when scope is Global', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  await screen.getByRole('button', { name: 'Sonnet' }).click();
  expect(onUpdate).toHaveBeenCalledWith({ defaultModel: 'sonnet-4.8' });
});

test('routes the patch to a project override under the project scope', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  // Switch to the per-project scope (tab labelled with the project name).
  await screen.getByRole('button', { name: 'nightcore' }).click();
  await screen.getByRole('button', { name: 'Opus' }).click();
  expect(onUpdate).toHaveBeenCalledWith({
    defaultModel: 'opus-4.8',
    projectId: 'nightcore',
  });
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
