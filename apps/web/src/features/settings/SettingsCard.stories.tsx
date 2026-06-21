import type { Meta, StoryObj } from '@storybook/react-vite';
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

const toggle = (
  <span className="inline-flex h-[18px] w-[32px] items-center rounded-full bg-primary px-0.5">
    <span className="ml-auto h-3.5 w-3.5 rounded-full bg-white" />
  </span>
);

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

/** A card carrying a roadmap (M2) affordance — kept visible, visually tagged. */
export const WithRoadmapBadge: Story = {
  args: {
    icon: '⚡',
    title: 'Autonomy',
    subtitle: 'Auto-loop and concurrency land in M2.',
    badge: 'M2',
    rows: [
      {
        label: 'Auto mode',
        hint: 'Continuously pick up eligible tasks.',
        control: toggle,
      },
      {
        label: 'Max parallel runs',
        hint: 'Concurrency slots for the auto-loop.',
        control: <span className="font-mono text-sm text-foreground">3</span>,
      },
    ],
  },
};
