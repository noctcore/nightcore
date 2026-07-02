import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './PrPicker.stories';

const { Loaded, Empty, Error: ErrorStory } = composeStories(stories);

test('selecting a PR from the list reports its number', async () => {
  const onChange = vi.fn();
  const screen = render(<Loaded onChange={onChange} />);
  await screen.getByRole('option', { name: /#128/ }).click();
  expect(onChange).toHaveBeenCalledWith(128);
});

test('filtering narrows the list by title/author/branch', async () => {
  const screen = render(<Loaded />);
  await screen.getByRole('textbox', { name: /filter open pull requests/i }).fill('alice');
  // Only PR #127 (author alice) survives.
  await expect.element(screen.getByRole('option', { name: /#127/ })).toBeInTheDocument();
  await expect
    .element(screen.getByRole('option', { name: /#128/ }))
    .not.toBeInTheDocument();
});

test('typing a number not in the list offers a manual review affordance', async () => {
  const onChange = vi.fn();
  const screen = render(<Loaded onChange={onChange} />);
  await screen
    .getByRole('textbox', { name: /filter open pull requests/i })
    .fill('999');
  const manual = screen.getByRole('button', { name: /review pr #999/i });
  await expect.element(manual).toBeInTheDocument();
  await manual.click();
  expect(onChange).toHaveBeenCalledWith(999);
});

test('the empty state still lets the user type a number', async () => {
  const onChange = vi.fn();
  const screen = render(<Empty onChange={onChange} />);
  await expect
    .element(screen.getByText(/no open pull requests/i))
    .toBeInTheDocument();
  await screen
    .getByRole('textbox', { name: /filter open pull requests/i })
    .fill('42');
  await screen.getByRole('button', { name: /review pr #42/i }).click();
  expect(onChange).toHaveBeenCalledWith(42);
});

test('a fetch error is surfaced inline but manual entry still works', async () => {
  const screen = render(<ErrorStory />);
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent(/no default remote repository/i);
});
