import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { CategoryTabs } from './CategoryTabs';
import type { CategoryTab } from './CategoryTabs.types';

const TABS: CategoryTab[] = [
  { key: 'all', count: 7, running: true, errored: false },
  { key: 'folder-structure', count: 3, running: false, errored: false },
  { key: 'naming', count: 0, running: true, errored: false },
  { key: 'imports-boundaries', count: 0, running: false, errored: true },
  { key: 'testing', count: 0, running: false, errored: false },
];

const meta = {
  title: 'Harness/CategoryTabs',
  component: CategoryTabs,
  args: {
    tabs: TABS,
    active: 'all',
    onSelect: fn(),
  },
} satisfies Meta<typeof CategoryTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NamingActive: Story = { args: { active: 'naming' } };
