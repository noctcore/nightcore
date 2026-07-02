import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './RunControls.stories';

const { Idle } = composeStories(stories);

// The stories render outside Tauri, so the open-PR list is empty — selection goes
// through the picker's typed-number escape hatch ("Review PR #N"), which is the
// same onChange path a click on a listed PR takes.

test('Review is disabled until a PR is chosen', async () => {
  const onReview = vi.fn();
  const screen = render(<Idle onReview={onReview} />);
  // All five lenses are selected by default, but with no PR chosen the CTA is off.
  await expect
    .element(screen.getByRole('button', { name: /^review pr$/i }))
    .toBeDisabled();

  await screen
    .getByRole('textbox', { name: /filter open pull requests/i })
    .fill('128');
  await screen.getByRole('button', { name: /review pr #128/i }).click();

  const cta = screen.getByRole('button', { name: /^review pr$/i });
  await expect.element(cta).toBeEnabled();
  await cta.click();
  expect(onReview).toHaveBeenCalledTimes(1);
});

test('a non-positive/non-numeric entry offers no PR and keeps Review off', async () => {
  const screen = render(<Idle />);
  await screen
    .getByRole('textbox', { name: /filter open pull requests/i })
    .fill('0');
  // 0 is not a valid PR number → no manual affordance appears.
  await expect
    .element(screen.getByRole('button', { name: /review pr #/i }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /^review pr$/i }))
    .toBeDisabled();
});

test('clearing the lens selection disables Review even with a PR chosen', async () => {
  const screen = render(<Idle />);
  await screen
    .getByRole('textbox', { name: /filter open pull requests/i })
    .fill('7');
  await screen.getByRole('button', { name: /review pr #7/i }).click();
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
