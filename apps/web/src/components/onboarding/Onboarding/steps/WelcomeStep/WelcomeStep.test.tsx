import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './WelcomeStep.stories';

const { Default } = composeStories(stories);

test('renders the onboarding welcome primer', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Welcome to nightcore.')).toBeInTheDocument();
  await expect.element(screen.getByText('Parallel agents')).toBeInTheDocument();
  await expect.element(screen.getByText('Human gates')).toBeInTheDocument();
});
