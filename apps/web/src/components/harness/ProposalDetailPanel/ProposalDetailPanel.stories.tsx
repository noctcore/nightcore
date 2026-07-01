import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { HarnessProposalVM } from '../harness.types';
import { ProposalDetailPanel } from './ProposalDetailPanel';

function proposal(over: Partial<HarnessProposalVM> = {}): HarnessProposalVM {
  return {
    id: 'hp-1',
    kind: 'agent-task',
    title: 'Wire the generated ESLint plugin into eslint.config.ts',
    description:
      'Register @acme/eslint-plugin in the flat config and enable component-folder-structure as an error.',
    rationale: 'An applied plugin sits inert until the flat config loads it.',
    artifactIds: [],
    prompt: 'Add @acme/eslint-plugin to eslint.config.ts and enable the rule as error.',
    verifyCommand: 'npx eslint .',
    harnessCheck: {
      name: 'component-folder-structure',
      kind: 'lint-plugin',
      command: 'npx eslint .',
    },
    confidence: 0.8,
    fingerprint: 'pfp1',
    status: 'proposed',
    linkedTaskId: null,
    ...over,
  };
}

const meta = {
  title: 'Harness/ProposalDetailPanel',
  component: ProposalDetailPanel,
  parameters: { layout: 'fullscreen' },
  args: {
    proposal: proposal(),
    pending: false,
    onClose: fn(),
    onConvert: fn(),
    onDismiss: fn(),
    onRestore: fn(),
    onGotoBoard: fn(),
  },
} satisfies Meta<typeof ProposalDetailPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const ApplyArtifacts: Story = {
  args: {
    proposal: proposal({
      id: 'hp-2',
      kind: 'apply-artifacts',
      title: 'Adopt the folder-per-component agent contract',
      description: 'Write the AGENTS.md guardrail section codifying colocation.',
      prompt: null,
      verifyCommand: null,
      harnessCheck: null,
      artifactIds: ['a1', 'a2'],
    }),
  },
};

export const Dismissed: Story = {
  args: { proposal: proposal({ status: 'dismissed' }) },
};

export const Converted: Story = {
  args: { proposal: proposal({ status: 'converted', linkedTaskId: 'task-1' }) },
};
