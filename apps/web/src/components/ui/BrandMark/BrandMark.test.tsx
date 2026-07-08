import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './BrandMark.stories';

const { Default } = composeStories(stories);

test('renders brand mark with accessible name', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByRole('img', { name: 'Nightcore' })).toBeVisible();
});
