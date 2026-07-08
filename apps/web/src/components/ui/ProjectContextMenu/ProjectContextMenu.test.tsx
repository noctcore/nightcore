import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProjectContextMenu.stories';

const { Default } = composeStories(stories);

test('renders child content', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Right-click me')).toBeInTheDocument();
});
