import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ComponentProps,useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Checkbox } from './Checkbox';

function ControlledCheckbox(
  props: Omit<ComponentProps<typeof Checkbox>, 'checked' | 'onChange'> & { initial?: boolean },
) {
  const [checked, setChecked] = useState(props.initial ?? false);
  return <Checkbox {...props} checked={checked} onChange={setChecked} />;
}

const meta = {
  title: 'UI/Checkbox',
  component: Checkbox,
  parameters: { layout: 'centered' },
  args: {
    label: 'Show grid lines',
    checked: false,
    onChange: fn(),
  },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {};

export const Checked: Story = { args: { checked: true } };

export const Disabled: Story = { args: { disabled: true } };

/** Play test: clicking toggles the checkbox. */
export const TogglesOnClick: Story = {
  render: (args) => <ControlledCheckbox label={args.label} initial={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByRole('checkbox', { name: 'Show grid lines' });
    await expect(box).not.toBeChecked();
    await userEvent.click(box);
    await expect(box).toBeChecked();
  },
};
