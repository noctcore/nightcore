import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { MotionProvider } from '../motion';
import { Segmented } from './Segmented';

function renderSegmented(value: string, onChange: (v: string) => void) {
  return render(
    <MotionProvider>
      <Segmented
        ariaLabel="Greek letters"
        options={[
          ['a', 'Alpha'],
          ['b', 'Beta'],
          ['c', 'Gamma'],
        ]}
        value={value}
        onChange={onChange}
      />
    </MotionProvider>,
  );
}

test('fires onChange with the picked value', async () => {
  const onChange = vi.fn();
  const screen = renderSegmented('a', onChange);
  await screen.getByRole('radio', { name: 'Beta' }).click();
  expect(onChange).toHaveBeenCalledWith('b');
});

test('renders a labeled radiogroup with every option as a radio', async () => {
  const screen = renderSegmented('a', vi.fn());
  await expect
    .element(screen.getByRole('radiogroup', { name: 'Greek letters' }))
    .toBeVisible();
  await expect.element(screen.getByRole('radio', { name: 'Alpha' })).toBeVisible();
  await expect.element(screen.getByRole('radio', { name: 'Beta' })).toBeVisible();
  await expect.element(screen.getByRole('radio', { name: 'Gamma' })).toBeVisible();
});

test('only the selected option is checked', async () => {
  const screen = renderSegmented('b', vi.fn());
  await expect
    .element(screen.getByRole('radio', { name: 'Alpha' }))
    .toHaveAttribute('aria-checked', 'false');
  await expect
    .element(screen.getByRole('radio', { name: 'Beta' }))
    .toHaveAttribute('aria-checked', 'true');
  await expect
    .element(screen.getByRole('radio', { name: 'Gamma' }))
    .toHaveAttribute('aria-checked', 'false');
});

test('the selected option is the sole roving entry (tabindex 0; the rest -1)', async () => {
  const screen = renderSegmented('b', vi.fn());
  await expect
    .element(screen.getByRole('radio', { name: 'Alpha' }))
    .toHaveAttribute('tabindex', '-1');
  await expect
    .element(screen.getByRole('radio', { name: 'Beta' }))
    .toHaveAttribute('tabindex', '0');
  await expect
    .element(screen.getByRole('radio', { name: 'Gamma' }))
    .toHaveAttribute('tabindex', '-1');
});

test('ArrowRight moves focus to the next option, selects it, and wraps at the end', async () => {
  const onChange = vi.fn();
  const screen = renderSegmented('c', onChange);
  const active = screen.getByRole('radio', { name: 'Gamma' });
  (active.element() as HTMLElement).focus();
  await expect.element(active).toHaveFocus();
  await userEvent.keyboard('{ArrowRight}');
  await expect.element(screen.getByRole('radio', { name: 'Alpha' })).toHaveFocus();
  expect(onChange).toHaveBeenCalledWith('a');
});

test('ArrowLeft moves focus to the previous option', async () => {
  const onChange = vi.fn();
  const screen = renderSegmented('b', onChange);
  const active = screen.getByRole('radio', { name: 'Beta' });
  (active.element() as HTMLElement).focus();
  await userEvent.keyboard('{ArrowLeft}');
  await expect.element(screen.getByRole('radio', { name: 'Alpha' })).toHaveFocus();
  expect(onChange).toHaveBeenCalledWith('a');
});

test('ArrowDown behaves like ArrowRight', async () => {
  const onChange = vi.fn();
  const screen = renderSegmented('a', onChange);
  const active = screen.getByRole('radio', { name: 'Alpha' });
  (active.element() as HTMLElement).focus();
  await userEvent.keyboard('{ArrowDown}');
  await expect.element(screen.getByRole('radio', { name: 'Beta' })).toHaveFocus();
  expect(onChange).toHaveBeenCalledWith('b');
});

test('falls back to an option-derived accessible name when no aria-label is given', async () => {
  const screen = render(
    <MotionProvider>
      <Segmented
        options={[
          ['a', 'Alpha'],
          ['b', 'Beta'],
        ]}
        value="a"
        onChange={vi.fn()}
      />
    </MotionProvider>,
  );
  await expect
    .element(screen.getByRole('radiogroup', { name: 'Alpha, Beta' }))
    .toBeVisible();
});

test('ariaLabelledBy takes precedence and suppresses aria-label', async () => {
  const screen = render(
    <MotionProvider>
      <span id="segmented-label">External label</span>
      <Segmented
        ariaLabel="Ignored"
        ariaLabelledBy="segmented-label"
        options={[
          ['a', 'Alpha'],
          ['b', 'Beta'],
        ]}
        value="a"
        onChange={vi.fn()}
      />
    </MotionProvider>,
  );
  await expect
    .element(screen.getByRole('radiogroup', { name: 'External label' }))
    .toBeVisible();
});
