import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './SettingsView.stories';

const { Global, NoActiveProject } = composeStories(stories);

test('updates a global setting when scope is Global', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  await screen.getByText('Sonnet').click();
  expect(onUpdate).toHaveBeenCalledWith({ defaultModel: 'sonnet-4.6' });
});

test('routes the patch to a project override under the project scope', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  // Switch to the per-project scope (tab labelled with the project name).
  await screen.getByText('nightcore', { exact: true }).click();
  await screen.getByText('Opus').click();
  expect(onUpdate).toHaveBeenCalledWith({
    defaultModel: 'opus-4.8',
    projectId: 'nightcore',
  });
});

test('disables the project scope tab when no project is active', async () => {
  const screen = render(<NoActiveProject />);
  await expect.element(screen.getByText('This project')).toBeDisabled();
});
