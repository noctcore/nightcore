import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProposedSubtasksPanel.stories';

const { Default, PartiallyConverted, AllConverted, Empty, EmptyWithError } =
  composeStories(stories);

/** Count the per-row "Convert" buttons (excludes the "Convert all" header button). */
function convertRowButtons(container: Element): Element[] {
  return [...container.querySelectorAll('button')].filter(
    (b) => b.textContent?.trim() === 'Convert',
  );
}

/** True when a "Convert all" header button is present. */
function hasConvertAll(container: Element): boolean {
  return [...container.querySelectorAll('button')].some((b) =>
    b.textContent?.includes('Convert all'),
  );
}

test('renders every proposal with a per-row Convert action when open', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Add the schema')).toBeInTheDocument();
  // Three open proposals → three per-row Convert buttons plus the Convert all.
  expect(convertRowButtons(screen.container)).toHaveLength(3);
  expect(hasConvertAll(screen.container)).toBe(true);
});

test('a converted proposal shows the task badge, not a Convert button', async () => {
  const screen = render(<PartiallyConverted />);
  // Exact match — "task" is otherwise a substring of the proposals' prompt text.
  await expect.element(screen.getByText('task', { exact: true })).toBeInTheDocument();
  // Only the two still-open rows expose a Convert button.
  expect(convertRowButtons(screen.container)).toHaveLength(2);
});

test('hides Convert all once every proposal is converted', async () => {
  const screen = render(<AllConverted />);
  expect(hasConvertAll(screen.container)).toBe(false);
  expect(convertRowButtons(screen.container)).toHaveLength(0);
});

test('a finished run with zero proposals shows the empty notice, no convert actions', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/produced no convertible sub-tasks/i))
    .toBeInTheDocument();
  // Nothing to convert → no per-row buttons and no bulk Convert all.
  expect(convertRowButtons(screen.container)).toHaveLength(0);
  expect(hasConvertAll(screen.container)).toBe(false);
});

test('the zero-proposal notice surfaces the failure reason when the run errored', async () => {
  const screen = render(<EmptyWithError />);
  await expect
    .element(screen.getByText(/produced no convertible sub-tasks/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/structured output retries exhausted/i))
    .toBeInTheDocument();
});
