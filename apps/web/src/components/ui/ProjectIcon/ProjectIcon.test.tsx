import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProjectIcon.stories';

const { Preset, Fallback } = composeStories(stories);

test('renders a preset lucide icon', async () => {
  const screen = render(<Preset />);
  expect(screen.container.querySelector('svg')).not.toBeNull();
});

test('falls back when no icon is set', async () => {
  const screen = render(<Fallback />);
  expect(screen.container.querySelector('svg')).not.toBeNull();
});
