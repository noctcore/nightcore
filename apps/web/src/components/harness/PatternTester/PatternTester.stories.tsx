import type { Meta, StoryObj } from '@storybook/react-vite';

import { PatternTester } from './PatternTester';
import type { PolicyProbeLists } from './PatternTester.types';

const LISTS: PolicyProbeLists = {
  protectedPaths: ['bun.lock', 'migrations/**'],
  denyReadPaths: ['.env*'],
  denyBashPatterns: ['--no-verify'],
  disallowedTools: ['WebSearch', 'mcp__acme__*'],
  askTools: ['WebFetch'],
};

const meta = {
  title: 'Harness/PatternTester',
  component: PatternTester,
  args: { lists: LISTS },
} satisfies Meta<typeof PatternTester>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A policy with no rules at all — every probe reports the path is wide open,
 *  except the implicit `.nightcore/**` self-protection. */
export const NoRules: Story = {
  args: {
    lists: {
      protectedPaths: [],
      denyReadPaths: [],
      denyBashPatterns: [],
      disallowedTools: [],
      askTools: [],
    },
  },
};
