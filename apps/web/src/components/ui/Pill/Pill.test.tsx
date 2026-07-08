import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Pill.stories';

const { Default } = composeStories(stories);

test('renders pill text', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('v1.2.3')).toBeVisible();
});
