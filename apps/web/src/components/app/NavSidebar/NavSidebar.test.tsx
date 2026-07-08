import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './NavSidebar.stories';

const { Default } = composeStories(stories);

test('renders grouped workspace nav', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Kanban Board')).toBeInTheDocument();
  await expect.element(screen.getByText('Project')).toBeInTheDocument();
  await expect.element(screen.getByText('Tools')).toBeInTheDocument();
});
