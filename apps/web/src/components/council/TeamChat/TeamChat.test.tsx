import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './TeamChat.stories';

const { Populated, Empty } = composeStories(stories);

test('projects the bus in order, labelling the conductor and each seat', async () => {
  const screen = render(<Populated />);
  await expect
    .element(screen.getByRole('heading', { name: 'Team chat' }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('Conductor').first()).toBeInTheDocument();
  await expect.element(screen.getByText('proposer-1').first()).toBeInTheDocument();
  // A quoted delivery surfaces its clean injection-scan provenance (safety #2).
  await expect.element(screen.getByText('scanned')).toBeInTheDocument();
});

test('shows an empty state before any messages stream', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText('No messages yet')).toBeInTheDocument();
});
