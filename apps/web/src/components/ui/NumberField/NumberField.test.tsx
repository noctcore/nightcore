import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { NumberField } from './NumberField';

test('renders with placeholder when value is null', async () => {
  const screen = render(
    <NumberField value={null} placeholder="8192" ariaLabel="Token limit" onCommit={vi.fn()} />,
  );
  const input = screen.getByRole('spinbutton', { name: 'Token limit' });
  await expect.element(input).toBeVisible();
  expect(input.element()).toHaveAttribute('placeholder', '8192');
});

test('Enter commits typed value', async () => {
  const onCommit = vi.fn();
  render(
    <NumberField value={null} placeholder="8192" ariaLabel="Token limit" onCommit={onCommit} min={0} />,
  );
  await userEvent.click(document.querySelector('[aria-label="Token limit"]') as HTMLElement);
  await userEvent.keyboard('2048{Enter}');
  expect(onCommit).toHaveBeenCalledWith(2048);
});

test('blur commits typed value', async () => {
  const onCommit = vi.fn();
  const screen = render(
    <NumberField value={null} placeholder="8192" ariaLabel="Token limit" onCommit={onCommit} min={0} />,
  );
  const input = screen.getByRole('spinbutton', { name: 'Token limit' });
  await input.fill('1024');
  await input.element().blur();
  expect(onCommit).toHaveBeenCalledWith(1024);
});
