import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { SettingsCard } from './SettingsCard';

const meta = {
  title: 'Settings/SettingsCard',
  component: SettingsCard,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 720 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SettingsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Models: Story = {
  args: {
    icon: '✦',
    title: 'Models',
    subtitle: 'Pick the default model and reasoning effort for new tasks.',
    rows: [
      {
        label: 'Default model',
        hint: 'Used when a task has no explicit model.',
        control: <span className="font-mono text-sm text-foreground">Opus 4.8</span>,
      },
      {
        label: 'Reasoning effort',
        hint: 'Higher effort trades latency for depth.',
        control: <span className="font-mono text-sm text-foreground">High</span>,
      },
    ],
  },
};

/** Scope honesty on a page that HAS a per-project choice, viewed on the global tab:
 *  the overridable row offers a jump to the project override; the global-only row
 *  admits that the project tab will not change it. */
export const ScopeOnGlobalTab: Story = {
  args: {
    icon: '⚿',
    title: 'Tool permissions',
    rows: [
      {
        label: 'Permission mode',
        hint: 'How the agent handles a tool that needs permission.',
        field: 'permissionMode',
        control: <span className="font-mono text-sm text-foreground">Auto</span>,
      },
      {
        label: 'Sandbox agent writes',
        hint: 'Block writes outside the task workspace at the OS layer.',
        field: 'sandboxSessions',
        control: <span className="font-mono text-sm text-foreground">Off</span>,
      },
    ],
    scopeSurface: { scope: 'global', projectName: 'nightcore', onScopeChange: fn() },
  },
};

/** The same card on the project tab: the overridable row names the project it is
 *  editing, and links back to the global default. */
export const ScopeOnProjectTab: Story = {
  args: {
    ...ScopeOnGlobalTab.args,
    scopeSurface: { scope: 'project', projectName: 'nightcore', onScopeChange: fn() },
  },
};
