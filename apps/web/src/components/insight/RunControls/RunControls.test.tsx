import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './RunControls.stories';

const { Idle } = composeStories(stories);

test('fires onAnalyze with every category selected by default', async () => {
  const onAnalyze = vi.fn();
  const screen = render(<Idle onAnalyze={onAnalyze} />);
  // Default hint reflects all nine lenses selected.
  await expect.element(screen.getByText(/across 9 lenses/i)).toBeInTheDocument();
  await screen.getByRole('button', { name: /^analyze$/i }).click();
  expect(onAnalyze).toHaveBeenCalledTimes(1);
});

test('clearing the selection disables Analyze', async () => {
  const onAnalyze = vi.fn();
  const screen = render(<Idle onAnalyze={onAnalyze} />);
  await screen.getByRole('button', { name: /^none$/i }).click();
  await expect
    .element(screen.getByRole('button', { name: /^analyze$/i }))
    .toBeDisabled();
});

test('toggling a category off updates the lens count hint', async () => {
  const screen = render(<Idle />);
  await screen.getByRole('button', { name: /^architecture$/i }).click();
  await expect.element(screen.getByText(/across 8 lenses/i)).toBeInTheDocument();
});
