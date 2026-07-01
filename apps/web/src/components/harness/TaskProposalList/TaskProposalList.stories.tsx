import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { HarnessProposalVM } from '../harness.types';
import { TaskProposalList } from './TaskProposalList';

function proposal(over: Partial<HarnessProposalVM> = {}): HarnessProposalVM {
  return {
    id: 'hp-1',
    kind: 'apply-artifacts',
    title: 'Adopt the folder-per-component agent contract',
    description: 'Write the AGENTS.md guardrail section codifying the colocation convention.',
    rationale: null,
    artifactIds: ['a1'],
    prompt: null,
    verifyCommand: null,
    harnessCheck: null,
    confidence: 0.8,
    fingerprint: 'pfp1',
    status: 'proposed',
    linkedTaskId: null,
    ...over,
  };
}

const meta = {
  title: 'Harness/TaskProposalList',
  component: TaskProposalList,
  args: {
    proposals: [
      proposal(),
      proposal({
        id: 'hp-2',
        kind: 'agent-task',
        title: 'Wire the generated ESLint plugin into eslint.config.ts',
        description:
          'Register @acme/eslint-plugin in the flat config and enable component-folder-structure as an error.',
        artifactIds: [],
        prompt: 'Add the plugin to eslint.config.ts and enable the rule.',
        verifyCommand: 'npx eslint .',
        harnessCheck: {
          name: 'component-folder-structure',
          kind: 'lint-plugin',
          command: 'npx eslint .',
        },
      }),
      proposal({ id: 'hp-3', title: 'A converted proposal', status: 'converted' }),
    ],
    loading: false,
    emptyMessage: 'Run a scan to synthesize proposals from your conventions.',
    onOpen: fn(),
  },
} satisfies Meta<typeof TaskProposalList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithProposals: Story = {};

export const Loading: Story = {
  args: { proposals: [], loading: true },
};

export const Empty: Story = {
  args: { proposals: [], loading: false },
};
