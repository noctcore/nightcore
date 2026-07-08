import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { MotionProvider } from '../motion';
import * as stories from './Button.stories';

const { Primary, FiresOnClick } = composeStories(stories);

test('renders button label', async () => {
  const screen = render(
    <MotionProvider>
      <Primary />
    </MotionProvider>,
  );
  await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
});

test('click invokes onClick', async () => {
  const onClick = vi.fn();
  const screen = render(
    <MotionProvider>
      <FiresOnClick onClick={onClick} />
    </MotionProvider>,
  );
  await screen.getByRole('button', { name: 'Save' }).click();
  expect(onClick).toHaveBeenCalled();
});
