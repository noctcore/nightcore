import type { Meta, StoryObj } from '@storybook/react-vite';

import { PolicyStarterPacks } from './PolicyStarterPacks';
import type { PolicyPackLists } from './PolicyStarterPacks.types';

const EMPTY: PolicyPackLists = {
  protectedPaths: [],
  denyBashPatterns: [],
  denyReadPaths: [],
  disallowedTools: [],
  askTools: [],
};

const meta = {
  title: 'Harness/PolicyStarterPacks',
  component: PolicyStarterPacks,
  args: {
    profile: {
      isMonorepo: true,
      languages: ['typescript', 'rust'],
      frameworks: ['react', 'tauri', 'vite'],
    },
    current: EMPTY,
    onApply: () => {},
  },
} satisfies Meta<typeof PolicyStarterPacks>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A Rust + Tauri monorepo: every universal pack plus all three keyed ones. */
export const Default: Story = {};

/** A project that has never been scanned — only the universal packs are offered. */
export const NoProfile: Story = {
  args: { profile: null },
};

/** A plain single-package TypeScript repo: no Rust, Tauri or monorepo packs. */
export const PlainRepo: Story = {
  args: {
    profile: { isMonorepo: false, languages: ['typescript'], frameworks: ['react'] },
  },
};

/** One pack already fully present in the draft reads as added, not clickable. */
export const PartiallyApplied: Story = {
  args: {
    current: {
      ...EMPTY,
      disallowedTools: ['WebFetch', 'WebSearch'],
    },
  },
};
