import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProjectRail.stories';

const { Default } = composeStories(stories);

test('renders project rail landmark', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByRole('complementary', { name: 'Projects' }))
    .toBeInTheDocument();
});
