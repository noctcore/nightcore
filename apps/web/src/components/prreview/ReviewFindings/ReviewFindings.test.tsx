import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ReviewFindings.stories';

const { Grouped, Empty } = composeStories(stories);

test('renders severity section headers and grounded locations', async () => {
  const screen = render(<Grouped />);
  // The severity label appears in both the section header and each card's badge,
  // so `.first()` targets the header without a multiple-match throw.
  await expect.element(screen.getByText('Critical').first()).toBeInTheDocument();
  await expect.element(screen.getByText('High').first()).toBeInTheDocument();
  await expect.element(screen.getByText('Low').first()).toBeInTheDocument();
  // The grounded location is rendered as inert file:line text.
  await expect.element(screen.getByText('src/a.ts:12').first()).toBeInTheDocument();
});

test('toggling a card checkbox fires the selection handler', async () => {
  const onToggleSelect = vi.fn();
  const screen = render(<Grouped onToggleSelect={onToggleSelect} />);
  // The checkbox input is sr-only; click its visible label to toggle it.
  await screen.getByText('Include in review').first().click();
  expect(onToggleSelect).toHaveBeenCalledTimes(1);
});

test('shows the empty message when there are no findings', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/review a pull request to surface findings/i))
    .toBeInTheDocument();
});
