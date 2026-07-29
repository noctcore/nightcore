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
  allowExecSinks: [],
  diffBudget: { maxChangedLines: 400, maxChangedFiles: null },
  manifestExists: true,
};

const meta = {
  title: 'Harness/PolicyEditor',
  component: PolicyEditor,
  args: {
    policy: POLICY,
    profile: {
      isMonorepo: true,
      languages: ['typescript', 'rust'],
      frameworks: ['react', 'tauri'],
    },
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
      allowExecSinks: [],
      diffBudget: null,
      manifestExists: false,
    },
  },
};

export const Loading: Story = {
  args: { policy: null },
};

/** A policy whose every tier holds a silently-dead rule — the #400 failure mode.
 *  Each row is diagnosed inline and save is blocked until they are fixed. */
export const DeadRules: Story = {
  args: {
    policy: {
      ...POLICY,
      protectedPaths: ['migrations/{2026,2027}', 'src\\**'],
      denyBashPatterns: ['**/*.lock'],
      denyReadPaths: ['.env*'],
      disallowedTools: ['Bash(git push:*)'],
      askTools: ['websearch'],
      allowTools: ['Bash(git status:*'],
    },
  },
};

export const SaveFailed: Story = {
  args: { saveError: 'harness.json is not valid JSON; fix it by hand before editing the policy' },
};
