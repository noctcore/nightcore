import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './RunControls.stories';

const { Idle } = composeStories(stories);

test('fires onGrade with every dimension selected by default', async () => {
  const onGrade = vi.fn();
  const screen = render(<Idle onGrade={onGrade} />);
  // Default hint reflects all ten dimensions selected.
  await expect
    .element(screen.getByText(/across 10 dimensions/i))
    .toBeInTheDocument();
  await screen.getByRole('button', { name: /grade readiness/i }).click();
  expect(onGrade).toHaveBeenCalledTimes(1);
});

test('clearing the selection disables Grade', async () => {
  const onGrade = vi.fn();
  const screen = render(<Idle onGrade={onGrade} />);
  await screen.getByRole('button', { name: /^none$/i }).click();
  await expect
    .element(screen.getByRole('button', { name: /grade readiness/i }))
    .toBeDisabled();
});

test('toggling a dimension off updates the dimension count hint', async () => {
  const screen = render(<Idle />);
  await screen.getByRole('button', { name: /^architecture$/i }).click();
  await expect
    .element(screen.getByText(/across 9 dimensions/i))
    .toBeInTheDocument();
});
