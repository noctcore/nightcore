import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './TaskStatusDot.stories';

const { Running, Failed } = composeStories(stories);

test('renders an aria-hidden status dot', async () => {
  const screen = render(<Running />);
  const dot = screen.container.querySelector('span[aria-hidden]');
  expect(dot).not.toBeNull();
});

test('maps the failed status to the destructive token', async () => {
  const screen = render(<Failed />);
  const dot = screen.container.querySelector('span[aria-hidden]');
  expect(dot?.className).toContain('bg-destructive');
});
