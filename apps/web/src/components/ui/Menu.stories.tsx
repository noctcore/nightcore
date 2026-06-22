import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Menu } from './Menu';
import { IconButton } from './IconButton';
import { DotsIcon, EditIcon, TrashIcon } from './icons';

const meta = {
  title: 'UI/Menu',
  component: Menu,
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    label: 'Project menu',
    trigger: (
      <IconButton label="Open menu">
        <DotsIcon size={16} />
      </IconButton>
    ),
    items: [
      { label: 'Rename', icon: <EditIcon size={14} />, onClick: fn() },
      { label: 'Remove', icon: <TrashIcon size={14} />, onClick: fn(), destructive: true },
    ],
  },
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

/** Play test: the menu opens on trigger click and exposes its items. */
export const Opens: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Open menu' }));
    await expect(canvas.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    await expect(canvas.getByRole('menuitem', { name: /remove/i })).toBeInTheDocument();
  },
};

/** Play test: selecting an item invokes its handler and closes the menu. */
export const SelectsItem: Story = {
  args: {
    items: [
      { label: 'Rename', icon: <EditIcon size={14} />, onClick: fn() },
      { label: 'Remove', icon: <TrashIcon size={14} />, onClick: fn(), destructive: true },
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Open menu' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: /rename/i }));
    await expect(args.items[0]?.onClick).toHaveBeenCalled();
    await expect(canvas.queryByRole('menu')).toBeNull();
  },
};
