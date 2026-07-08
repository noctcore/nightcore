import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Spinner.stories';

const { Default } = composeStories(stories);

test('renders spinner element', async () => {
  const screen = render(<Default />);
  expect(screen.container.querySelector('[aria-hidden="true"]')).not.toBeNull();
});
