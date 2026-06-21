import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ModelEffortPicker } from './ModelEffortPicker';

const meta = {
  title: 'Board/ModelEffortPicker',
  component: ModelEffortPicker,
  args: {
    model: null,
    effort: null,
    onChangeModel: fn(),
    onChangeEffort: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 460, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ModelEffortPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inherit: Story = {};

export const OpusHigh: Story = { args: { model: 'claude-opus-4-8', effort: 'high' } };

export const LegacyModelId: Story = { args: { model: 'sonnet-4.6', effort: 'medium' } };

export const Disabled: Story = { args: { model: 'claude-haiku-4-5-20251001', disabled: true } };

/** Play test: picking a model fires onChangeModel with the canonical id. */
export const PicksModel: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const models = within(canvas.getByRole('radiogroup', { name: /model/i }));
    await userEvent.click(models.getByRole('radio', { name: /sonnet/i }));
    await expect(args.onChangeModel).toHaveBeenCalledWith('claude-sonnet-4-6');
  },
};

/** Play test: picking an effort level fires onChangeEffort. */
export const PicksEffort: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const efforts = within(canvas.getByRole('radiogroup', { name: /reasoning effort/i }));
    await userEvent.click(efforts.getByRole('radio', { name: /^high$/i }));
    await expect(args.onChangeEffort).toHaveBeenCalledWith('high');
  },
};
