import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { RepoLink } from './RepoLink';

const meta = {
  title: 'UI/RepoLink',
  component: RepoLink,
  parameters: { layout: 'centered' },
  args: { href: 'https://github.com/example/nightcore' },
} satisfies Meta<typeof RepoLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ExternalLinkAttrs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = canvas.getByRole('link', { name: /open repo/i });
    await expect(link).toHaveAttribute('href', 'https://github.com/example/nightcore');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noreferrer');
  },
};
