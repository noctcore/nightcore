import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './GitStateRow.stories';

const { Valid, Checking, NotARepo } = composeStories(stories);

test('shows the detected-repo label', async () => {
  const screen = render(<Valid />);
  await expect.element(screen.getByText('Git repository detected.')).toBeInTheDocument();
});

test('shows the in-flight checking label', async () => {
  const screen = render(<Checking />);
  await expect.element(screen.getByText('Checking…')).toBeInTheDocument();
});

test('offers git init when the folder is not a repo', async () => {
  const onInitGit = vi.fn();
  const screen = render(<NotARepo onInitGit={onInitGit} />);
  await expect.element(screen.getByText('Not a git repository.')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'git init' }).click();
  expect(onInitGit).toHaveBeenCalled();
});
