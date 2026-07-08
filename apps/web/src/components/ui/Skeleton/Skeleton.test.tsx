import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Skeleton.stories';

const { Line } = composeStories(stories);

test('renders skeleton placeholder', async () => {
  const screen = render(<Line />);
  expect(screen.container.querySelector('.nc-skeleton')).not.toBeNull();
});
