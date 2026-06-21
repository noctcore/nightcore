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

test('renders the reserved Review/Decompose kinds as disabled', async () => {
  const screen = render(<Build />);
  await expect.element(screen.getByRole('radio', { name: /review/i })).toBeDisabled();
  await expect.element(screen.getByRole('radio', { name: /decompose/i })).toBeDisabled();
});
