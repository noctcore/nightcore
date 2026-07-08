import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Badge.stories';

const { Neutral } = composeStories(stories);

test('renders label text', async () => {
  const screen = render(<Neutral />);
  await expect.element(screen.getByText('beta')).toBeVisible();
});
