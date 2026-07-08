import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { DotsIcon } from '../icons';
import { MotionProvider } from '../motion';
import { IconButton } from './IconButton';
import * as stories from './IconButton.stories';

const { Default } = composeStories(stories);

test('renders with accessible name', async () => {
  const screen = render(
    <MotionProvider>
      <Default />
    </MotionProvider>,
  );
  await expect.element(screen.getByRole('button', { name: 'More options' })).toBeVisible();
});

test('click invokes onClick', async () => {
  const onClick = vi.fn();
  const screen = render(
    <MotionProvider>
      <IconButton label="More options" onClick={onClick}>
        <DotsIcon size={16} />
      </IconButton>
    </MotionProvider>,
  );
  await screen.getByRole('button', { name: 'More options' }).click();
  expect(onClick).toHaveBeenCalled();
});
