import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ConstitutionCard } from './ConstitutionCard';

const meta = {
  title: 'Settings/ConstitutionCard',
  component: ConstitutionCard,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 760 }}>
        <Story />
      </div>
    ),
  ],
  args: { enabled: true, onToggleEnabled: fn(), projectActive: true },
} satisfies Meta<typeof ConstitutionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A project with an authored pack, injection on (loads the browser-preview mock). */
export const Active: Story = {};

/** Injection toggled off — the pack is authored but not injected into runs. */
export const Disabled: Story = { args: { enabled: false } };

/** No active project: the editor shows its empty state. */
export const NoProject: Story = { args: { projectActive: false } };
