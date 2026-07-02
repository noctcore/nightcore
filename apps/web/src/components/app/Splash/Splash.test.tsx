import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Splash.stories';

const { Default, CustomBootLine } = composeStories(stories);

test('renders the brand and the default boot line', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('nightcore')).toBeInTheDocument();
  await expect
    .element(screen.getByText('initializing workspace…'))
    .toBeInTheDocument();
});

test('shows a custom boot line and version', async () => {
  const screen = render(<CustomBootLine />);
  await expect.element(screen.getByText('loading projects…')).toBeInTheDocument();
  await expect.element(screen.getByText(/v0\.2\.0/)).toBeInTheDocument();
});
