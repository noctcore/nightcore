import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { Checkbox } from './Checkbox';

test('renders unchecked checkbox with label', async () => {
  const screen = render(<Checkbox checked={false} onChange={vi.fn()} label="Show grid" />);
  const box = screen.getByRole('checkbox', { name: 'Show grid' });
  await expect.element(box).toBeVisible();
  expect(box.element()).not.toBeChecked();
});

test('click toggles onChange', async () => {
  const onChange = vi.fn();
  const screen = render(<Checkbox checked={false} onChange={onChange} label="Show grid" />);
  await screen.getByText('Show grid').click();
  expect(onChange).toHaveBeenCalledWith(true);
});

test('Space toggles onChange', async () => {
  const onChange = vi.fn();
  render(<Checkbox checked={false} onChange={onChange} label="Show grid" />);
  await userEvent.tab();
  await userEvent.keyboard(' ');
  expect(onChange).toHaveBeenCalledWith(true);
});

test('srSuffix widens the accessible name without changing the visible label', async () => {
  const screen = render(
    <Checkbox
      checked={false}
      onChange={vi.fn()}
      label="Include in review"
      srSuffix="Unchecked unwrap in auth.ts"
    />,
  );
  // The accessible name carries the suffix so same-labelled rows are distinct…
  await expect
    .element(screen.getByRole('checkbox', { name: 'Include in review Unchecked unwrap in auth.ts' }))
    .toBeInTheDocument();
  // …but the visible label text is unchanged (the suffix is sr-only).
  await expect.element(screen.getByText('Include in review')).toBeVisible();
});
