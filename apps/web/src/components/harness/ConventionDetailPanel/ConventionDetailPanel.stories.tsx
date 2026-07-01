import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { ConventionFindingVM } from '../harness.types';
import { ConventionDetailPanel } from './ConventionDetailPanel';

function finding(over: Partial<ConventionFindingVM> = {}): ConventionFindingVM {
  return {
    id: 'c1',
    category: 'folder-structure',
    kind: 'convention',
    severity: 'high',
    title: 'Folder-per-component with a colocated sibling set',
    description: 'Every component ships its hooks, types, story, test, and barrel.',
    rationale: 'Logic, types, and tests travel with the component, so a move is atomic.',
    evidence: [
      { file: 'apps/web/src/components/board/TaskCard/TaskCard.tsx', startLine: 1, endLine: 40, symbol: 'TaskCard' },
      { file: 'apps/web/src/components/insight/RunControls/RunControls.tsx', startLine: 1, endLine: null, symbol: null },
    ],
    suggestion: 'Codify it with an ESLint rule that asserts the sibling set on disk.',
    tags: ['folder-per-component', 'architecture'],
    confidence: 0.9,
    fingerprint: 'fp1',
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

const meta = {
  title: 'Harness/ConventionDetailPanel',
  component: ConventionDetailPanel,
  parameters: { layout: 'fullscreen' },
  args: {
    finding: finding(),
    pending: false,
    onClose: fn(),
    onConvert: fn(),
    onDismiss: fn(),
    onRestore: fn(),
    onGotoBoard: fn(),
  },
} satisfies Meta<typeof ConventionDetailPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Gap: Story = {
  args: { finding: finding({ kind: 'gap', title: 'No enforced import boundary' }) },
};

export const Dismissed: Story = {
  args: { finding: finding({ status: 'dismissed' }) },
};

export const Converted: Story = {
  args: { finding: finding({ status: 'converted', linkedTaskId: 'task-1' }) },
};
