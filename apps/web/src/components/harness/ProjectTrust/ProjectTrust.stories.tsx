import type { Meta, StoryObj } from '@storybook/react-vite';

import type { ProjectTrustSummary } from '@/lib/bridge';

import { ProjectTrust } from './ProjectTrust';

/** A project with real governance history — the shape a lead actually reads. */
const SUMMARY: ProjectTrustSummary = {
  generatedAt: '2026-07-29T14:20:00Z',
  merges: { tasks: 46, merged: 31, verified: 29, verifiedMerges: 28 },
  gauntlet: { runs: 34, passed: 32, passRate: 32 / 34 },
  guardrails: {
    toolsEvaluated: 4182,
    allowed: 4106,
    asked: 41,
    denied: 35,
    policyDenials: 22,
    sessions: 46,
    topRules: [
      { ruleId: 'harness-protected-path', count: 14, source: 'policy' },
      { ruleId: 'harness-bash-deny', count: 8, source: 'policy' },
      { ruleId: 'pipe-to-shell', count: 7, source: 'builtin' },
    ],
  },
  spend: { costUsd: 41.87, tasksWithCost: 39 },
  journal: {
    events: 12,
    quarantines: 2,
    policySaves: 5,
    arms: 3,
    disarms: 1,
    ratchets: 1,
    other: 0,
    corruptLines: 0,
    lastEventAt: '2026-07-29T13:58:11Z',
    recent: [
      {
        id: '11',
        ts: '2026-07-29T13:58:11Z',
        kind: 'quarantine',
        summary: 'quarantined 1 path(s) from agent reads',
        detail: ['docs/vendor/CHANGELOG.md'],
      },
      {
        id: '10',
        ts: '2026-07-29T13:57:40Z',
        kind: 'policy-save',
        summary: 'policy saved — armed, 4 protected path(s), 3 bash denial(s)',
        detail: [],
      },
      {
        id: '9',
        ts: '2026-07-28T09:14:02Z',
        kind: 'arm',
        summary: 'armed check `structure-lock` (lint-meta)',
        detail: ['structure-lock'],
      },
      {
        id: '8',
        ts: '2026-07-27T16:02:55Z',
        kind: 'disarm',
        summary: 'removed check `legacy-shell`',
        detail: ['legacy-shell'],
      },
      {
        id: '7',
        ts: '2026-07-26T08:30:00Z',
        kind: 'future-kind',
        summary: 'something a newer build recorded',
        detail: [],
      },
    ],
  },
  badge: {
    schemaVersion: 1,
    label: 'governance',
    message: '28 verified merges · 94% gauntlet · 35 denials',
    color: 'green',
  },
};

/** A repo that has never run a gate: honest zeroes, never a green claim. */
const UNMEASURED: ProjectTrustSummary = {
  ...SUMMARY,
  merges: { tasks: 0, merged: 0, verified: 0, verifiedMerges: 0 },
  gauntlet: { runs: 0, passed: 0, passRate: null },
  guardrails: {
    toolsEvaluated: 0,
    allowed: 0,
    asked: 0,
    denied: 0,
    policyDenials: 0,
    sessions: 0,
    topRules: [],
  },
  spend: { costUsd: 0, tasksWithCost: 0 },
  journal: {
    events: 0,
    quarantines: 0,
    policySaves: 0,
    arms: 0,
    disarms: 0,
    ratchets: 0,
    other: 0,
    corruptLines: 0,
    lastEventAt: null,
    recent: [],
  },
  badge: {
    schemaVersion: 1,
    label: 'governance',
    message: 'not measured',
    color: 'lightgrey',
  },
};

const meta = {
  title: 'Harness/ProjectTrust',
  component: ProjectTrust,
  args: {
    summary: SUMMARY,
    loading: false,
    exporting: false,
    onRefresh: () => {},
    onExportBadge: () => {},
  },
} satisfies Meta<typeof ProjectTrust>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Loaded with no history — distinct from "still loading". */
export const Unmeasured: Story = {
  args: { summary: UNMEASURED },
};

/** A journal with unreadable lines: the corruption is stated, not hidden. */
export const CorruptJournal: Story = {
  args: {
    summary: {
      ...SUMMARY,
      journal: { ...SUMMARY.journal, corruptLines: 3 },
    },
  },
};

export const Loading: Story = {
  args: { summary: null, loading: true },
};
