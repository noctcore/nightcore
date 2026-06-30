import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import type { BranchInfo } from '@/lib/bridge';
import { BranchPicker } from './BranchPicker';
import * as stories from './BranchPicker.stories';

const { Disabled } = composeStories(stories);

const branches: BranchInfo[] = [
  { name: 'main', isRemote: false, isCurrent: true, upstream: 'origin/main', ahead: 0, behind: 0 },
  { name: 'nc/branch-picker', isRemote: false, isCurrent: false, ahead: 2, behind: 1 },
  { name: 'nc/insight-feature', isRemote: false, isCurrent: false, ahead: 0, behind: 0 },
  { name: 'origin/nc/branch-picker', isRemote: true, isCurrent: false, ahead: 0, behind: 0 },
];

test('opens on focus and groups local vs remote', async () => {
  const screen = render(<BranchPicker value="" onChange={vi.fn()} branches={branches} />);
  expect(screen.container.querySelector('[role="listbox"]')).toBeNull();
  await screen.getByRole('combobox').click();
  await expect.element(screen.getByRole('listbox')).toBeInTheDocument();
  await expect.element(screen.getByText('Local')).toBeInTheDocument();
  await expect.element(screen.getByText('Remote')).toBeInTheDocument();
});

test('filters by the typed text (case-insensitive)', async () => {
  const screen = render(<BranchPicker value="INSIGHT" onChange={vi.fn()} branches={branches} />);
  await screen.getByRole('combobox').click();
  await expect
    .element(screen.getByRole('option', { name: /nc\/insight-feature/i }))
    .toBeInTheDocument();
  expect(screen.getByRole('option', { name: /branch-picker/i }).query()).toBeNull();
});

test('shows the ahead/behind tracking for a diverged branch', async () => {
  const screen = render(<BranchPicker value="picker" onChange={vi.fn()} branches={branches} />);
  await screen.getByRole('combobox').click();
  await expect.element(screen.getByText('↑2 ↓1')).toBeInTheDocument();
});

test('clicking a branch fires onChange with its name', async () => {
  const onChange = vi.fn();
  const screen = render(<BranchPicker value="" onChange={onChange} branches={branches} />);
  await screen.getByRole('combobox').click();
  await screen.getByRole('option', { name: /nc\/insight-feature/i }).click();
  expect(onChange).toHaveBeenCalledWith('nc/insight-feature');
});

test('arrow-down + Enter picks the highlighted branch', async () => {
  const onChange = vi.fn();
  const screen = render(<BranchPicker value="nc" onChange={onChange} branches={branches} />);
  await screen.getByRole('combobox').click();
  await userEvent.keyboard('{ArrowDown}{Enter}');
  expect(onChange).toHaveBeenCalledWith('nc/insight-feature');
});

test('Escape closes the dropdown', async () => {
  const screen = render(<BranchPicker value="nc" onChange={vi.fn()} branches={branches} />);
  await screen.getByRole('combobox').click();
  await expect.element(screen.getByRole('listbox')).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(screen.container.querySelector('[role="listbox"]')).toBeNull();
});

test('offers a create row that keeps the typed value', async () => {
  const onChange = vi.fn();
  const screen = render(<BranchPicker value="nc/brand-new" onChange={onChange} branches={branches} />);
  await screen.getByRole('combobox').click();
  await expect.element(screen.getByText('No matching branches')).toBeInTheDocument();
  await screen.getByRole('option', { name: /create/i }).click();
  expect(onChange).toHaveBeenCalledWith('nc/brand-new');
});

test('suppresses the create row when allowCreate is false', async () => {
  const screen = render(
    <BranchPicker value="zzz-nope" onChange={vi.fn()} branches={branches} allowCreate={false} />,
  );
  await screen.getByRole('combobox').click();
  await expect.element(screen.getByText('No matching branches')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /create/i }).query()).toBeNull();
});

test('disabled input does not open the dropdown', async () => {
  const screen = render(<Disabled />);
  await expect.element(screen.getByRole('combobox')).toBeDisabled();
  expect(screen.container.querySelector('[role="listbox"]')).toBeNull();
});
