import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ImageDropzone } from './ImageDropzone';
import type { ImageDropzoneItem } from './ImageDropzone.types';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const items: ImageDropzoneItem[] = [
  { id: 'a', filename: 'screenshot.png', previewUrl: PNG_1PX, size: 1024 },
  { id: 'b', filename: 'mock.png', previewUrl: null },
];

const meta = {
  title: 'UI/ImageDropzone',
  component: ImageDropzone,
  args: {
    items: [],
    onAddFiles: fn(),
    onRemove: fn(),
    canAddMore: true,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 420, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ImageDropzone>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithItems: Story = { args: { items } };

export const AtLimit: Story = { args: { items, canAddMore: false } };

export const ReadOnly: Story = { args: { items, readOnly: true } };

export const WithError: Story = {
  args: { error: '"huge.png" is larger than 10 MB.' },
};

/** Play test: the remove button fires onRemove with the item id. */
export const RemovesItem: Story = {
  args: { items },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /remove screenshot\.png/i }));
    await expect(args.onRemove).toHaveBeenCalledWith('a');
  },
};
