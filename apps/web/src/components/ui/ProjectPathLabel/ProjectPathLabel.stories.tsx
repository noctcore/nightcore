import type { Meta, StoryObj } from '@storybook/react-vite';

import { ProjectPathLabel } from './ProjectPathLabel';

const meta = {
  title: 'UI/ProjectPathLabel',
  component: ProjectPathLabel,
  parameters: { layout: 'centered' },
  args: { path: '\\\\?\\X:\\shiro-suite\\shiranami' },
} satisfies Meta<typeof ProjectPathLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WindowsDevicePath: Story = {};

export const UnixPath: Story = {
  args: { path: '/Users/developer/projects/nightcore' },
};
