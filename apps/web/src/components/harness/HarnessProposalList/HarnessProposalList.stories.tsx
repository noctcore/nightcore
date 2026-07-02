import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { ProposedArtifactVM } from '../harness.types';
import { HarnessProposalList } from './HarnessProposalList';

function artifact(over: Partial<ProposedArtifactVM> = {}): ProposedArtifactVM {
  return {
    id: 'a1',
    kind: 'eslint-rule',
    group: 'eslint-plugin',
    groupTitle: 'ESLint plugin (@acme/eslint-plugin)',
    title: 'component-folder-structure',
    description: 'Assert the colocated sibling set on disk.',
    rationale: null,
    targetPath: 'packages/eslint-plugin/src/rules/component-folder-structure.ts',
    writeMode: 'create',
    content: "import { createRule } from '../utils';\n\nexport const rule = createRule({\n  name: 'component-folder-structure',\n  // ...\n});",
    language: 'typescript',
    sourceFindings: ['fp1'],
    dependsOn: [],
    confidence: null,
    fingerprint: 'afp1',
    status: 'proposed',
    appliedPath: null,
    appliedAt: null,
    ...over,
  };
}

const meta = {
  title: 'Harness/HarnessProposalList',
  component: HarnessProposalList,
  args: {
    artifacts: [
      artifact(),
      artifact({
        id: 'a2',
        kind: 'eslint-plugin-file',
        title: 'plugin entry',
        targetPath: 'packages/eslint-plugin/src/index.ts',
      }),
      artifact({
        id: 'a3',
        kind: 'agent-contract',
        group: null,
        groupTitle: null,
        title: 'Agent guardrails',
        targetPath: 'CLAUDE.md',
        writeMode: 'merge-section',
        content: '## Conventions\n- Folder-per-component\n- No cross-feature imports',
      }),
    ],
    loading: false,
    emptyMessage: 'Run a scan to synthesize a proposed harness.',
    onOpen: fn(),
  },
} satisfies Meta<typeof HarnessProposalList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithArtifacts: Story = {};

export const Loading: Story = {
  args: { artifacts: [], loading: true },
};

export const Empty: Story = {
  args: { artifacts: [], loading: false },
};
