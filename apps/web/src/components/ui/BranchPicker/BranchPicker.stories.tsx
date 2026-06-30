import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { BranchInfo } from '@/lib/bridge';
import { BranchPicker } from './BranchPicker';

const branches: BranchInfo[] = [
  { name: 'main', isRemote: false, isCurrent: true, upstream: 'origin/main', ahead: 0, behind: 0 },
  { name: 'nc/branch-picker', isRemote: false, isCurrent: false, upstream: 'origin/nc/branch-picker', ahead: 2, behind: 1 },
  { name: 'nc/insight-feature', isRemote: false, isCurrent: false, ahead: 0, behind: 0 },
  { name: 'feat/worktree-status', isRemote: false, isCurrent: false, ahead: 5, behind: 0 },
  { name: 'origin/main', isRemote: true, isCurrent: false, ahead: 0, behind: 0 },
  { name: 'origin/nc/branch-picker', isRemote: true, isCurrent: false, ahead: 0, behind: 0 },
];

const meta = {
  title: 'UI/BranchPicker',
  component: BranchPicker,
  args: {
    value: '',
    onChange: fn(),
    branches,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BranchPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

/** Focusing the input opens the dropdown with the local + remote groups. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    await expect(canvas.getByRole('listbox')).toBeInTheDocument();
    await expect(canvas.getByText('Local')).toBeInTheDocument();
    await expect(canvas.getByText('Remote')).toBeInTheDocument();
  },
};

/** Typing filters the list (case-insensitive substring). */
export const Filtered: Story = {
  args: { value: 'insight' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    await expect(canvas.getByRole('option', { name: /nc\/insight-feature/i })).toBeInTheDocument();
    expect(canvas.queryByRole('option', { name: /feat\/worktree-status/i })).toBeNull();
  },
};

/** A query matching no branch offers the create row. */
export const Create: Story = {
  args: { value: 'nc/new-thing' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    await expect(canvas.getByRole('option', { name: /create/i })).toBeInTheDocument();
    await expect(canvas.getByText('No matching branches')).toBeInTheDocument();
  },
};

/** With creation disabled, an unmatched query shows only the empty row. */
export const NoCreate: Story = {
  args: { value: 'zzz-nope', allowCreate: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    await expect(canvas.getByText('No matching branches')).toBeInTheDocument();
    expect(canvas.queryByRole('option', { name: /create/i })).toBeNull();
  },
};

export const Disabled: Story = { args: { value: 'main', disabled: true } };

/** Play test: clicking a branch fires onChange with its name. */
export const PicksBranch: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    await userEvent.click(canvas.getByRole('option', { name: /feat\/worktree-status/i }));
    await expect(args.onChange).toHaveBeenCalledWith('feat/worktree-status');
  },
};

/** Play test: clicking the create row keeps the typed value. */
export const PicksCreate: Story = {
  args: { value: 'nc/new-thing' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox'));
    await userEvent.click(canvas.getByRole('option', { name: /create/i }));
    await expect(args.onChange).toHaveBeenCalledWith('nc/new-thing');
  },
};
