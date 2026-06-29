import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { BugIcon, PerfIcon, VerifiedIcon } from '../icons';
import { CategoryTabsShell } from './CategoryTabsShell';
import type { CategoryTabDescriptor } from './CategoryTabsShell.types';

const tabs: CategoryTabDescriptor[] = [
  { key: 'all', label: 'All', icon: null, count: 7, running: true, errored: false },
  { key: 'bugs', label: 'Bugs', icon: BugIcon, count: 3, running: false, errored: false },
  { key: 'security', label: 'Security', icon: VerifiedIcon, count: 0, running: true, errored: false },
  { key: 'performance', label: 'Performance', icon: PerfIcon, count: 0, running: false, errored: true },
];

const meta = {
  title: 'UI/CategoryTabsShell',
  component: CategoryTabsShell,
  args: {
    tabs,
    active: 'all',
    onSelect: fn(),
    listLabel: 'Finding categories',
    errorLabel: 'analysis failed',
  },
} satisfies Meta<typeof CategoryTabsShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const BugsActive: Story = { args: { active: 'bugs' } };
