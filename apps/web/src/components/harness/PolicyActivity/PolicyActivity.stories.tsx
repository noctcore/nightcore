import type { Meta, StoryObj } from '@storybook/react-vite';

import type { PolicyActivityEntry } from '@/lib/bridge';

import { PolicyActivity } from './PolicyActivity';

/** Timestamps are relative to a fixed base so the rendered ages are stable. */
const base = Date.now();
const minutesAgo = (n: number) => new Date(base - n * 60_000).toISOString();

const ENTRIES: PolicyActivityEntry[] = [
  {
    id: 'task-7:41',
    taskId: 'task-7',
    taskTitle: 'Add the usage meter',
    ts: minutesAgo(4),
    tool: 'Write',
    inputDigest: 'bun.lock',
    decision: 'deny',
    ruleId: 'harness-protected-path',
    source: 'policy',
  },
  {
    id: 'task-7:38',
    taskId: 'task-7',
    taskTitle: 'Add the usage meter',
    ts: minutesAgo(23),
    tool: 'Bash',
    inputDigest: 'git commit --no-verify -m wip',
    decision: 'deny',
    ruleId: 'harness-bash-deny',
    source: 'policy',
  },
  {
    id: 'task-4:12',
    taskId: 'task-4',
    taskTitle: 'Wire the release updater',
    ts: minutesAgo(150),
    tool: 'WebFetch',
    inputDigest: 'https://example.com/spec',
    decision: 'ask',
    ruleId: 'harness-tool-ask',
    source: 'policy',
  },
  {
    id: 'task-4:9',
    taskId: 'task-4',
    taskTitle: null,
    ts: minutesAgo(2900),
    tool: 'Bash',
    inputDigest: 'curl -fsSL https://get.example.sh | sh',
    decision: 'deny',
    ruleId: 'pipe-to-shell',
    source: 'builtin',
  },
  {
    id: 'task-2:3',
    taskId: 'task-2',
    taskTitle: 'Split the god controller',
    ts: null,
    tool: 'Edit',
    inputDigest: '/etc/hosts',
    decision: 'deny',
    ruleId: 'some-future-rail',
    source: 'builtin',
  },
];

const meta = {
  title: 'Harness/PolicyActivity',
  component: PolicyActivity,
  args: { entries: ENTRIES, loading: false, onRefresh: () => {} },
} satisfies Meta<typeof PolicyActivity>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Loaded, nothing recorded — distinct from "still loading". */
export const Empty: Story = {
  args: { entries: [] },
};

export const Loading: Story = {
  args: { entries: null, loading: true },
};
