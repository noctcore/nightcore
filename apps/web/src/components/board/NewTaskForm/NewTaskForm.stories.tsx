import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { NewTaskForm } from './NewTaskForm';

const meta = {
  title: 'Board/NewTaskForm',
  component: NewTaskForm,
  parameters: { layout: 'fullscreen' },
  args: {
    onCreate: fn(async () => {}),
    onClose: fn(),
  },
} satisfies Meta<typeof NewTaskForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Play test: the create button is gated on a title, then fires onCreate with
 *  the default `build` kind. */
export const CreatesTask: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const create = canvas.getByRole('button', { name: /create task/i });
    // Disabled with an empty title.
    await expect(create).toBeDisabled();

    await userEvent.type(
      canvas.getByLabelText('Task title'),
      'Add a settings panel',
    );
    await userEvent.type(
      canvas.getByLabelText('Task description'),
      'Build the settings surface.',
    );
    await expect(create).toBeEnabled();
    await userEvent.click(create);

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith(
        'Add a settings panel',
        'Build the settings surface.',
        'build',
      ),
    );
  },
};

/** Play test: picking the Research kind threads it through onCreate. */
export const CreatesResearchTask: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Task title'), 'Survey caching options');
    await userEvent.click(canvas.getByRole('radio', { name: /research/i }));
    await userEvent.click(canvas.getByRole('button', { name: /create task/i }));

    await waitFor(() =>
      expect(args.onCreate).toHaveBeenCalledWith('Survey caching options', '', 'research'),
    );
  },
};
