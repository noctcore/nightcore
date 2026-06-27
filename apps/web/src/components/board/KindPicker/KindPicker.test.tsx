import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './KindPicker.stories';

const { Build, Research, Disabled } = composeStories(stories);

test('marks the selected kind as checked', async () => {
  const screen = render(<Build />);
  await expect
    .element(screen.getByRole('radio', { name: /build/i }))
    .toHaveAttribute('aria-checked', 'true');
});

test('fires onChange with an enabled kind when picked', async () => {
  const onChange = vi.fn();
  const screen = render(<Research onChange={onChange} />);
  await screen.getByRole('radio', { name: /build/i }).click();
  expect(onChange).toHaveBeenCalledWith('build');
});

test('disables every option when the picker is disabled', async () => {
  const screen = render(<Disabled />);
  await expect.element(screen.getByRole('radio', { name: /build/i })).toBeDisabled();
  await expect.element(screen.getByRole('radio', { name: /research/i })).toBeDisabled();
});

test('all four kinds are selectable and Review is not offered', async () => {
  const screen = render(<Build />);
  for (const name of [/build/i, /research/i, /tdd/i, /decompose/i]) {
    await expect.element(screen.getByRole('radio', { name })).not.toBeDisabled();
  }
  // Exactly four radios — `review` (the internal verification-reviewer identity) is
  // never a picker option, so it must not render.
  expect(screen.container.querySelectorAll('[role="radio"]')).toHaveLength(4);
});
