import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { SearchIcon } from '../icons';
import { IconTile } from './IconTile';
import * as stories from './IconTile.stories';

const { Medium } = composeStories(stories);

test('renders icon inside tile', async () => {
  const screen = render(
    <IconTile>
      <SearchIcon size={18} />
    </IconTile>,
  );
  expect(screen.container.querySelector('svg')).not.toBeNull();
});

test('story renders', async () => {
  render(<Medium />);
});
