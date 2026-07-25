import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Toggle } from './Toggle';

function ControlledToggle(props: { label: string; initial?: boolean }) {
  const [on, setOn] = useState(props.initial ?? false);
  return <Toggle label={props.label} on={on} onChange={setOn} />;
}

const meta = {
  title: 'UI/Toggle',
  component: Toggle,
  parameters: { layout: 'centered' },
  args: { label: 'Auto mode', on: false, onChange: fn() },
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};

export const On: Story = { args: { on: true } };

export const Disabled: Story = { args: { on: true, disabled: true } };

/** Play test: clicking toggles the switch. */
export const TogglesOnClick: Story = {
  render: () => <ControlledToggle label="Auto mode" initial={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sw = canvas.getByRole('switch', { name: 'Auto mode' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    await expect(sw).toHaveAttribute('aria-checked', 'true');
  },
};
