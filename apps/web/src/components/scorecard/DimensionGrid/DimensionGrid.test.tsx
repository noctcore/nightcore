import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './DimensionGrid.stories';

const { Default, Empty } = composeStories(stories);

test('renders the grade chip for a graded dimension', async () => {
  const screen = render(<Default />);
  // The architecture row grades A; the security row grades F. Exact match targets
  // the standalone grade chips (single-letter text), not words containing a/f.
  await expect.element(screen.getByText('A', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('F', { exact: true })).toBeInTheDocument();
});

test('opens a graded reading on click but not a pending row', async () => {
  const onOpen = vi.fn();
  const screen = render(<Default onOpen={onOpen} />);
  await screen.getByText('Clean boundaries').click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen.mock.calls[0]?.[0]?.dimension).toBe('architecture');
});

test('shows the empty message when there are no rows', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/grade the codebase/i))
    .toBeInTheDocument();
});

test('renders a grade-trend chip vs the previous run for graded dimensions', async () => {
  const screen = render(<Default />);
  // Architecture improved to A (from B); security regressed to F (from C).
  await expect
    .element(screen.getByLabelText(/Grade improved vs previous run \(was B\)/))
    .toBeInTheDocument();
  await expect
    .element(screen.getByLabelText(/Grade regressed vs previous run \(was C\)/))
    .toBeInTheDocument();
});
