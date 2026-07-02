import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './RunControls.stories';

const { Idle } = composeStories(stories);

test('Review is disabled until a valid PR number is entered', async () => {
  const onReview = vi.fn();
  const screen = render(<Idle onReview={onReview} />);
  // All five lenses are selected by default, but with no PR number the CTA is off.
  await expect
    .element(screen.getByRole('button', { name: /^review pr$/i }))
    .toBeDisabled();

  await screen.getByRole('spinbutton', { name: /pull request/i }).fill('128');
  const cta = screen.getByRole('button', { name: /^review pr$/i });
  await expect.element(cta).toBeEnabled();
  await cta.click();
  expect(onReview).toHaveBeenCalledTimes(1);
});

test('a non-numeric PR number surfaces an inline error and keeps Review off', async () => {
  const screen = render(<Idle />);
  await screen.getByRole('spinbutton', { name: /pull request/i }).fill('0');
  await expect
    .element(screen.getByText(/enter a positive pr number/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /^review pr$/i }))
    .toBeDisabled();
});

test('clearing the lens selection disables Review even with a PR number', async () => {
  const screen = render(<Idle />);
  await screen.getByRole('spinbutton', { name: /pull request/i }).fill('7');
  await screen.getByRole('button', { name: /^none$/i }).click();
  await expect
    .element(screen.getByRole('button', { name: /^review pr$/i }))
    .toBeDisabled();
});

test('toggling a lens off updates the lens count hint', async () => {
  const screen = render(<Idle />);
  await expect.element(screen.getByText(/across 5 lenses/i)).toBeInTheDocument();
  await screen.getByRole('button', { name: /^security$/i }).click();
  await expect.element(screen.getByText(/across 4 lenses/i)).toBeInTheDocument();
});
