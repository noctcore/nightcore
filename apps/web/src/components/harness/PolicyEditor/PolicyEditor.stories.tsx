import type { Meta, StoryObj } from '@storybook/react-vite';

import type { HarnessPolicyFile } from '@/lib/bridge';

import { PolicyEditor } from './PolicyEditor';

const POLICY: HarnessPolicyFile = {
  enabled: true,
  protectedPaths: ['bun.lock', 'migrations/**'],
  denyBashPatterns: ['--no-verify'],
  denyReadPaths: ['.env*'],
  disallowedTools: ['WebSearch'],
  askTools: ['WebFetch'],
  allowTools: ['Bash(git status:*)'],
  diffBudget: { maxChangedLines: 400, maxChangedFiles: null },
  manifestExists: true,
};

const meta = {
  title: 'Harness/PolicyEditor',
  component: PolicyEditor,
  args: {
    policy: POLICY,
    saving: false,
    saveError: null,
    onSave: () => {},
  },
} satisfies Meta<typeof PolicyEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoManifest: Story = {
  args: {
    policy: {
      enabled: true,
      protectedPaths: [],
      denyBashPatterns: [],
      denyReadPaths: [],
      disallowedTools: [],
      askTools: [],
      allowTools: [],
      diffBudget: null,
      manifestExists: false,
    },
  },
};

export const Loading: Story = {
  args: { policy: null },
};

export const SaveFailed: Story = {
  args: { saveError: 'harness.json is not valid JSON; fix it by hand before editing the policy' },
};
