import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './IconPicker.stories';

const { Default } = composeStories(stories);

test('filters icons when searching', async () => {
  const screen = render(<Default />);
  await screen.getByLabelText('Search icons').fill('Rocket');
  await expect.element(screen.getByLabelText('Rocket')).toBeInTheDocument();
});
