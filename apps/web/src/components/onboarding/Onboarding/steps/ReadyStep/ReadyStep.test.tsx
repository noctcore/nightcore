import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ReadyStep.stories';

const { Default } = composeStories(stories);

test('renders the launch-ready checklist', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('You are set.')).toBeInTheDocument();
  await expect.element(screen.getByText('Claude Code')).toBeInTheDocument();
  await expect.element(screen.getByText('Project board')).toBeInTheDocument();
});
