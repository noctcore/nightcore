import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { ModelSelection } from '../ModelSelect';
import { ModelSelectField } from './ModelSelectField';
import type { ModelSelectFieldProps } from './ModelSelectField.types';

/** A controlled harness so the story reflects picks (the field is fully controlled).
 *  Outside Tauri the bridge seams degrade to the curated static catalog + Claude
 *  capabilities, so the live wrapper renders without a backend. */
function ControlledField(props: Omit<ModelSelectFieldProps, 'value' | 'onChange'>) {
  const [value, setValue] = useState<ModelSelection>({ model: null, effort: null });
  return <ModelSelectField {...props} value={value} onChange={setValue} />;
}

const meta = {
  title: 'UI/ModelSelectField',
  component: ModelSelectField,
  args: { value: { model: null, effort: null }, onChange: fn() },
  decorators: [
    (Story) => (
      <div style={{ width: 460, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ModelSelectField>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The live-wired picker resolves its catalog from the bridge (static fallback in
 *  preview) and shows the reasoning-effort row (Claude `supportsEffort`). */
export const Default: Story = {
  render: () => <ControlledField />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('combobox', { name: /model/i })).toBeInTheDocument();
    await expect(canvas.getByRole('radiogroup', { name: /reasoning effort/i })).toBeInTheDocument();
  },
};

/** Picking a model from the live catalog updates the controlled selection. */
export const PicksModel: Story = {
  render: () => <ControlledField />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: /model/i }));
    await userEvent.click(canvas.getByRole('option', { name: /sonnet/i }));
    await expect(canvas.getByRole('combobox', { name: /model/i })).toHaveTextContent(/sonnet/i);
  },
};

export const Disabled: Story = {
  render: () => <ControlledField disabled />,
};
