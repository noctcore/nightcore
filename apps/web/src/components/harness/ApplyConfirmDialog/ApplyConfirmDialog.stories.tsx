import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { ProposedArtifactVM } from '../harness.types';
import { ApplyConfirmDialog } from './ApplyConfirmDialog';

const ARTIFACT: ProposedArtifactVM = {
  id: 'a1',
  kind: 'eslint-rule',
  group: 'eslint-plugin',
  groupTitle: 'ESLint plugin',
  title: 'component-folder-structure',
  description: 'Assert the colocated sibling set on disk.',
  rationale: null,
  targetPath: 'packages/eslint-plugin/src/rules/component-folder-structure.ts',
  writeMode: 'create',
  content: 'export const rule = {};',
  language: 'typescript',
  sourceFindings: ['fp1'],
  dependsOn: [],
  confidence: null,
  fingerprint: 'afp1',
  status: 'proposed',
  appliedPath: null,
  appliedAt: null,
};

const meta = {
  title: 'Harness/ApplyConfirmDialog',
  component: ApplyConfirmDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    artifact: ARTIFACT,
    applying: false,
    error: null,
    onConfirm: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof ApplyConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Applying: Story = { args: { applying: true } };

// A refused `create` over an existing path — the raw Rust error is translated into
// a friendly, actionable explanation.
export const WithError: Story = {
  args: { error: 'file already exists (os error 17): eslint.config.mjs' },
};

// A non-"already exists" failure passes through verbatim.
export const GenericError: Story = {
  args: { error: 'permission denied (os error 13)' },
};

export const MergeSection: Story = {
  args: {
    artifact: {
      ...ARTIFACT,
      kind: 'agent-contract',
      title: 'Agent guardrails',
      targetPath: 'CLAUDE.md',
      writeMode: 'merge-section',
    },
  },
};
