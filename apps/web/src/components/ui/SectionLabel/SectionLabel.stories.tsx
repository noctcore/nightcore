import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { SectionLabel } from './SectionLabel';

const meta = {
  title: 'UI/SectionLabel',
  component: SectionLabel,
  parameters: { layout: 'centered' },
  args: { children: 'Run config' },
} satisfies Meta<typeof SectionLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const RendersLabel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Run config')).toBeInTheDocument();
  },
};
