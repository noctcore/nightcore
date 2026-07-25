import { composeStories } from '@storybook/react-vite';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ScanLimits } from '@/lib/bridge';

import { chipClass } from './LensChipGrid';
import * as stories from './LensChipGrid.stories';

// Control the #401 ceiling preview precisely; keep the rest of the bridge real.
const previewMock = vi.fn<(passCount: number) => Promise<ScanLimits>>();
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    previewScanLimits: (passCount: number) => previewMock(passCount),
  };
});

const { Default, Starting, NoneSelected } = composeStories(stories);

// Default to "no Settings ceiling" — the pre-#401 shape — so every test that isn't
// ABOUT the ceiling renders exactly as it did before the note existed.
beforeEach(() => {
  previewMock.mockReset();
  previewMock.mockResolvedValue({});
});

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

// --- spend-ceiling note (#401) --------------------------------------------
//
// This copy is the only place a user sees what a scan will cost BEFORE paying, so
// the numbers are pinned, not smoke-tested.

test('shows no ceiling note when Settings carries no limits', async () => {
  previewMock.mockResolvedValue({});
  const screen = render(<Default />);
  // The CTA renders, so the form is up — and no ceiling copy appears with it.
  await expect
    .element(screen.getByRole('button', { name: /analyze/i }))
    .toBeEnabled();
  expect(screen.container.textContent).not.toContain('Ceiling');
});

test('reports the per-pass budget alongside the total it divided from', async () => {
  // 2 selected categories in the Default story; $5 total ⇒ $2.50 each.
  previewMock.mockResolvedValue({
    maxBudgetUsdPerPass: 2.5,
    maxBudgetUsdTotal: 5,
  });
  const screen = render(<Default />);
  await expect
    .element(screen.getByText(/\$2\.50 per category · \$5\.00 max/))
    .toBeInTheDocument();
});

test('reports a turn ceiling per unit, undivided', async () => {
  previewMock.mockResolvedValue({ maxTurnsPerPass: 200 });
  const screen = render(<Default />);
  await expect
    .element(screen.getByText(/200 turns per category/))
    .toBeInTheDocument();
});

test('re-resolves the ceiling when the selection size changes', async () => {
  previewMock.mockResolvedValue({
    maxBudgetUsdPerPass: 2.5,
    maxBudgetUsdTotal: 5,
  });
  render(<Default />);
  await vi.waitFor(() => expect(previewMock).toHaveBeenCalled());
  // The pass count drives the divisor, so it must be what we ask Rust about.
  expect(previewMock).toHaveBeenCalledWith(2);
});
