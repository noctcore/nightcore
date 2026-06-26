import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ALL_CATEGORIES } from '../harness.constants';
import { RunControls } from './RunControls';

const meta = {
  title: 'Harness/RunControls',
  component: RunControls,
  args: {
    model: 'claude-opus-4-8',
    effort: 'high',
    selected: new Set(ALL_CATEGORIES),
    isStarting: false,
    disabled: false,
    onChangeModel: fn(),
    onChangeEffort: fn(),
    onToggle: fn(),
    onSelectAll: fn(),
    onSelectNone: fn(),
    onScan: fn(),
  },
} satisfies Meta<typeof RunControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { selected: new Set() },
};

export const Starting: Story = {
  args: { isStarting: true },
};
