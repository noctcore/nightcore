import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './EmptyState.stories';

const { TitleOnly } = composeStories(stories);

test('renders title', async () => {
  const screen = render(<TitleOnly />);
  await expect.element(screen.getByText('No tasks yet')).toBeVisible();
});
