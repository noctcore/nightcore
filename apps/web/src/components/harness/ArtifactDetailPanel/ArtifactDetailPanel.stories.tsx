import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { ProposedArtifactVM } from '../harness.types';
import { ArtifactDetailPanel } from './ArtifactDetailPanel';

function artifact(over: Partial<ProposedArtifactVM> = {}): ProposedArtifactVM {
  return {
    id: 'a1',
    kind: 'eslint-rule',
    group: 'eslint-plugin',
    groupTitle: 'ESLint plugin (@acme/eslint-plugin)',
    title: 'component-folder-structure',
    description: 'Assert that every component folder ships its colocated sibling set.',
    rationale: 'Agents keep adding bare components; this rule fails the build when a sibling is missing.',
    targetPath: 'packages/eslint-plugin/src/rules/component-folder-structure.ts',
    writeMode: 'create',
    content:
      "import { createRule } from '../utils';\n\nexport const rule = createRule({\n  name: 'component-folder-structure',\n  // ...\n});\n",
    language: 'typescript',
    sourceFindings: ['fp-folder-per-component'],
    dependsOn: [],
    confidence: 0.85,
    fingerprint: 'afp1',
    status: 'proposed',
    appliedPath: null,
    appliedAt: null,
    ...over,
  };
}

const meta = {
  title: 'Harness/ArtifactDetailPanel',
  component: ArtifactDetailPanel,
  parameters: { layout: 'fullscreen' },
  args: {
    artifact: artifact(),
    pending: false,
    onClose: fn(),
    onApply: fn(),
    onDismiss: fn(),
    onRestore: fn(),
    onArm: fn(),
  },
} satisfies Meta<typeof ArtifactDetailPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Proposed: Story = {};

export const Applied: Story = {
  args: {
    artifact: artifact({
      status: 'applied',
      appliedPath: 'packages/eslint-plugin/src/rules/component-folder-structure.ts',
      appliedAt: 1234,
    }),
  },
};

export const Dismissed: Story = {
  args: { artifact: artifact({ status: 'dismissed' }) },
};
