import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProjectIconEditor.stories';

const { Default } = composeStories(stories);

test('selects a preset icon through the controlled callback', async () => {
  const onIconChange = vi.fn();
  const screen = render(<Default onIconChange={onIconChange} />);

  await screen.getByRole('button', { name: 'Rocket' }).click();

  expect(onIconChange).toHaveBeenCalledWith('Rocket');
});

test('offers image removal only when a custom image exists', async () => {
  const onRemoveImage = vi.fn();
  const screen = render(
    <Default hasCustomImage imageUrl="data:image/png;base64,AA==" onRemoveImage={onRemoveImage} />,
  );

  await screen.getByRole('button', { name: 'Remove image' }).click();

  expect(onRemoveImage).toHaveBeenCalledOnce();
});
