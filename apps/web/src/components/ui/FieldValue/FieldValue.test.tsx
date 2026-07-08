import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './FieldValue.stories';

const { Default } = composeStories(stories);

test('renders value text', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('main')).toBeVisible();
});
