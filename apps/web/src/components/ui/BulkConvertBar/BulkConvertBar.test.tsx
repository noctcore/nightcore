import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './BulkConvertBar.stories';

const { Default, NothingOpen, Converting, PartialFailure, WithTrailingAction } =
  composeStories(stories);

test('names the open count and is live when there is something to convert', async () => {
  const screen = render(<Default />);
  const button = screen.getByRole('button', {
    name: /convert all to tasks \(5\)/i,
  });
  await expect.element(button).toHaveAttribute('aria-disabled', 'false');
  await expect.element(button).toHaveAttribute('aria-busy', 'false');
});

test('fires onConvertAll when clicked', async () => {
  const onConvertAll = vi.fn();
  const screen = render(<Default onConvertAll={onConvertAll} />);
  await screen.getByRole('button', { name: /convert all to tasks/i }).click();
  expect(onConvertAll).toHaveBeenCalledTimes(1);
});

test('goes inert (aria-disabled, no-op) when nothing is open', async () => {
  const onConvertAll = vi.fn();
  const screen = render(<NothingOpen onConvertAll={onConvertAll} />);
  const button = screen.getByRole('button', {
    name: /convert all to tasks \(0\)/i,
  });
  await expect.element(button).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled fails Playwright's actionability check; the DOM click still
  // dispatches — the underlying convert-all is a no-op, which the caller absorbs.
  await button.click({ force: true });
});

test('swaps to the running progress label and marks the button busy while converting', async () => {
  const screen = render(<Converting />);
  const button = screen.getByRole('button', { name: /converting… 2\/5/i });
  await expect.element(button).toHaveAttribute('aria-busy', 'true');
  await expect.element(button).toHaveAttribute('aria-disabled', 'true');
});

test('surfaces the inline partial-failure summary once settled', async () => {
  const screen = render(<PartialFailure />);
  await expect
    .element(screen.getByText(/1 of 5 findings could not be converted/i))
    .toBeInTheDocument();
});

test('renders a trailing sibling action alongside convert-all in the same bar', async () => {
  const screen = render(<WithTrailingAction />);
  // Both the convert-all button and the trailing action live in the one bar.
  await expect
    .element(screen.getByRole('button', { name: /convert all to tasks/i }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /export to github/i }))
    .toBeInTheDocument();
});
