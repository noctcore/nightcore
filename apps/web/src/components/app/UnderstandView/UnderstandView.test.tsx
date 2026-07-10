import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './UnderstandView.stories';

const { Idle, NoProject } = composeStories(stories);

test('renders the Find | Grade toggle above the Find lens by default', async () => {
  const screen = render(<Idle />);
  // Default mode = Find → Insight is mounted.
  await expect.element(screen.getByRole('button', { name: 'Find' })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Grade' })).toBeVisible();
  await expect
    .element(screen.getByRole('heading', { name: 'Insight' }))
    .toBeInTheDocument();
});

test('toggling to Grade mounts the Scorecard lens', async () => {
  const screen = render(<Idle />);
  await screen.getByRole('button', { name: 'Grade' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'Scorecard' }))
    .toBeInTheDocument();
});

test('toggling back to Find remounts the Insight lens', async () => {
  const screen = render(<Idle />);
  await screen.getByRole('button', { name: 'Grade' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'Scorecard' }))
    .toBeInTheDocument();
  await screen.getByRole('button', { name: 'Find' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'Insight' }))
    .toBeInTheDocument();
});

test('forwards no-active-project through to the mounted lens', async () => {
  const screen = render(<NoProject />);
  await expect.element(screen.getByText('No active project')).toBeInTheDocument();
});
