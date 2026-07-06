import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { chipClass } from './LensChipGrid';
import * as stories from './LensChipGrid.stories';

const { Default, Starting, NoneSelected } = composeStories(stories);

test('renders the heading, chips with pressed state, and the CTA', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Categories (2/4)')).toBeInTheDocument();
  const bugs = screen.getByRole('button', { name: /bugs/i });
  await expect.element(bugs).toHaveAttribute('aria-pressed', 'true');
  const arch = screen.getByRole('button', { name: /architecture/i });
  await expect.element(arch).toHaveAttribute('aria-pressed', 'false');
  await expect
    .element(screen.getByRole('button', { name: /analyze/i }))
    .toBeEnabled();
});

test('toggling a chip and All/None fire the callbacks', async () => {
  const onToggle = vi.fn();
  const onSelectAll = vi.fn();
  const onSelectNone = vi.fn();
  const screen = render(
    <Default
      onToggle={onToggle}
      onSelectAll={onSelectAll}
      onSelectNone={onSelectNone}
    />,
  );
  await screen.getByRole('button', { name: /performance/i }).click();
  expect(onToggle).toHaveBeenCalledWith('performance');
  await screen.getByRole('button', { name: 'All' }).click();
  expect(onSelectAll).toHaveBeenCalled();
  await screen.getByRole('button', { name: 'None' }).click();
  expect(onSelectNone).toHaveBeenCalled();
});

test('the starting state shows the busy CTA and disables it', async () => {
  const screen = render(<Starting />);
  const cta = screen.getByRole('button', { name: /starting/i });
  await expect.element(cta).toBeDisabled();
  await expect.element(cta).toHaveAttribute('aria-busy', 'true');
});

test('an empty selection disables the CTA', async () => {
  const screen = render(<NoneSelected />);
  await expect
    .element(screen.getByRole('button', { name: /analyze/i }))
    .toBeDisabled();
});

test('chipClass switches between the selected and unselected palettes', () => {
  expect(chipClass(true)).toContain('border-primary/60');
  expect(chipClass(false)).toContain('border-border');
});
