import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './StagesStep.stories';

const { Default } = composeStories(stories);

test('names all five stages, in lifecycle order, with their destinations', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('How Nightcore works')).toBeInTheDocument();

  const headings = screen.getByRole('heading', { level: 2 }).elements();
  expect(headings.map((h) => h.textContent)).toEqual([
    'Intake',
    'Understand',
    'Harden',
    'Enforce',
    'Verify',
  ]);

  // Each row names the nav destination the stage routes to — the diagram doubles as
  // a map of the sidebar.
  await expect.element(screen.getByText('Issue Triage', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('Find & Grade', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('PR Review', { exact: true })).toBeInTheDocument();
});

test('explains what each stage leaves behind', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText('leaves behind: Validated tasks on the board'))
    .toBeInTheDocument();
});
