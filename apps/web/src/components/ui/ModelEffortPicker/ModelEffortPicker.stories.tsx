import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { ModelEffortPicker } from './ModelEffortPicker';

/** @deprecated demo — the ModelEffortPicker is a thin adapter over
 *  `ModelSelectField` kept for one deprecation cycle. Outside Tauri the live catalog
 *  + capability seams degrade to the curated static catalog + Claude capabilities. */
const meta = {
  title: 'UI/ModelEffortPicker (deprecated)',
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

export const OpusHigh: Story = { args: { model: 'claude-opus-5-5', effort: 'high' } };

export const Disabled: Story = { args: { model: 'claude-haiku-4-5', disabled: true } };

/** Play test: the deprecated adapter still delegates a model pick to `onChangeModel`
 *  with the canonical id (now through the combobox it wraps). */
export const PicksModel: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: /model/i }));
    await userEvent.click(canvas.getByRole('option', { name: /sonnet/i }));
    await expect(args.onChangeModel).toHaveBeenCalledWith('claude-sonnet-5');
  },
};

/** Play test: switching from Opus (effort=max) to Haiku — which can't honor `max` —
 *  reconciles the pinned effort back to Inherit, delegated via `onChangeEffort`. */
export const SwitchingModelResetsUnsupportedEffort: Story = {
  args: { model: 'claude-opus-5-5', effort: 'max' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: /model/i }));
    await userEvent.click(canvas.getByRole('option', { name: /haiku/i }));
    await expect(args.onChangeModel).toHaveBeenCalledWith('claude-haiku-4-5');
    await expect(args.onChangeEffort).toHaveBeenCalledWith(null);
  },
};
