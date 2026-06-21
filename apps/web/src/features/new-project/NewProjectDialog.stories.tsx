import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { NewProjectDialog } from './NewProjectDialog';

const meta = {
  title: 'NewProject/NewProjectDialog',
  component: NewProjectDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    models: ['Opus 4.8', 'Sonnet 4.5', 'Haiku 4'],
    onChooseFolder: fn(),
    onCreate: fn(),
    onClose: fn(),
    folder: null,
  },
} satisfies Meta<typeof NewProjectDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No folder chosen yet — create is disabled. */
export const NoFolder: Story = {};

/** Folder chosen — ready to name and create. */
export const FolderChosen: Story = {
  args: { folder: '~/dev/my-project' },
};

/** Play test: create stays disabled until a folder + name are present. */
export const CreatesProject: Story = {
  args: { folder: '~/dev/my-project' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const create = canvas.getByRole('button', { name: /create project/i });
    // Folder present but name empty → still disabled.
    await expect(create).toBeDisabled();

    await userEvent.type(canvas.getByLabelText('Project name'), 'my-project');
    await expect(create).toBeEnabled();
    await userEvent.click(create);

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ folder: '~/dev/my-project', name: 'my-project' }),
      ),
    );
  },
};
