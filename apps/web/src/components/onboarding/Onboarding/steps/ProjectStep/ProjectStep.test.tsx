import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProjectStep.stories';

const { Empty, FolderSelected } = composeStories(stories);

test('renders the selected repository and project name', async () => {
  const screen = render(<FolderSelected />);
  await expect.element(screen.getByText('First project')).toBeInTheDocument();
  await expect.element(screen.getByText('Repository selected')).toBeInTheDocument();
  await expect.element(screen.getByLabelText('Project name')).toHaveValue('nightcore');
});

test('renders the empty project picker state', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('Choose repository folder')).toBeInTheDocument();
  await expect.element(screen.getByText('No folder selected')).toBeInTheDocument();
});
