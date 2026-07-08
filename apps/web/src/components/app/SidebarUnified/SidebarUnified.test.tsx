import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './SidebarUnified.stories';

const { Default } = composeStories(stories);

test('shows active project name', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByTitle('nightcore')).toBeInTheDocument();
});
