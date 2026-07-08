import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { MotionProvider } from '../motion';
import { Segmented } from './Segmented';

function renderSegmented(value: string, onChange: (v: string) => void) {
  return render(
    <MotionProvider>
      <Segmented
        options={[
          ['a', 'Alpha'],
          ['b', 'Beta'],
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
  await screen.getByRole('button', { name: 'Beta' }).click();
  expect(onChange).toHaveBeenCalledWith('b');
});

test('renders every option as a button', async () => {
  const screen = renderSegmented('a', vi.fn());
  await expect.element(screen.getByRole('button', { name: 'Alpha' })).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Beta' })).toBeVisible();
});
