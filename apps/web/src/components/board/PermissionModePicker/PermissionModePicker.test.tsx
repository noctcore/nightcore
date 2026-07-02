import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './PermissionModePicker.stories';

const { Inherit, Bypass, Disabled } = composeStories(stories);

test('marks Inherit checked when the value is null', async () => {
  const screen = render(<Inherit />);
  await expect
    .element(screen.getByRole('radio', { name: /inherit/i }))
    .toHaveAttribute('aria-checked', 'true');
});

test('marks the selected mode checked', async () => {
  const screen = render(<Bypass />);
  await expect
    .element(screen.getByRole('radio', { name: /bypass/i }))
    .toHaveAttribute('aria-checked', 'true');
});

test('fires onChange with the picked mode', async () => {
  const onChange = vi.fn();
  const screen = render(<Inherit onChange={onChange} />);
  await screen.getByRole('radio', { name: /^ask$/i }).click();
  expect(onChange).toHaveBeenCalledWith('ask');
});

test('fires onChange with null when Inherit is picked', async () => {
  const onChange = vi.fn();
  const screen = render(<Bypass onChange={onChange} />);
  await screen.getByRole('radio', { name: /inherit/i }).click();
  expect(onChange).toHaveBeenCalledWith(null);
});

test('disables every option when disabled', async () => {
  const screen = render(<Disabled />);
  await expect.element(screen.getByRole('radio', { name: /inherit/i })).toBeDisabled();
  await expect.element(screen.getByRole('radio', { name: /bypass/i })).toBeDisabled();
});
