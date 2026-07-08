import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Card.stories';

const { Default } = composeStories(stories);

test('renders children', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Card body')).toBeVisible();
});
