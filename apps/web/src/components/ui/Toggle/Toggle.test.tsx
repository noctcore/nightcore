import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { Toggle } from './Toggle';

test('renders switch with accessible name', async () => {
  const screen = render(<Toggle on={false} onChange={vi.fn()} label="Auto mode" />);
  const sw = screen.getByRole('switch', { name: 'Auto mode' });
  await expect.element(sw).toBeVisible();
  expect(sw.element()).toHaveAttribute('aria-checked', 'false');
});

test('click toggles onChange', async () => {
  const onChange = vi.fn();
  const screen = render(<Toggle on={false} onChange={onChange} label="Auto mode" />);
  await screen.getByRole('switch', { name: 'Auto mode' }).click();
  expect(onChange).toHaveBeenCalledWith(true);
});
