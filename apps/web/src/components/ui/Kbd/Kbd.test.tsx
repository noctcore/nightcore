import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Kbd.stories';

const { Single } = composeStories(stories);

test('renders key cap text', async () => {
  const screen = render(<Single />);
  await expect.element(screen.getByText('Esc')).toBeVisible();
});
