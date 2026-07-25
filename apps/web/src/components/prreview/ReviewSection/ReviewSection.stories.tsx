import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { PrFixState, ReviewLens } from '@/lib/bridge';
import { seedStepState } from '@/lib/scan-run';
import { useRunConfig } from '@/lib/useRunConfig';

import type { FixRunCardProps } from '../FixRunCard';
import { ALL_LENSES, LENS_META } from '../prreview.constants';
import type { ReviewFindingView } from '../prreview.types';
import type { TimelineStep } from '../prreview-lifecycle';
import { EMPTY_REVIEW_STREAM, type ReviewStream } from '../prreview-stream';
import { ReviewSection } from './ReviewSection';
import type {
  ReviewSectionHistorySlice,
  ReviewSectionMode,
  ReviewSectionToolbarSlice,
} from './ReviewSection.types';

const LENSES: ReviewLens[] = ['security', 'logic'];

function finding(over: Partial<ReviewFindingView> = {}): ReviewFindingView {
  return {
    id: 'f1',
    lens: 'security',
    severity: 'high',
    file: 'src/auth.ts',
    line: 42,
    title: 'Token logged in plain text',
    body: 'The session token is written to the debug log.',
    suggestedFix: null,
    fingerprint: 'fp-1',
    corroboratedBy: [],
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

function completedStream(): ReviewStream {
  return {
    ...EMPTY_REVIEW_STREAM,
    runId: 'run-1',
    status: 'completed',
    prNumber: 128,
    model: 'claude',
    requestedLenses: LENSES,
    lensState: { security: 'done', logic: 'done' },
    findings: [finding(), finding({ id: 'f2', severity: 'medium', line: null })],
    // Realistic usage so a healthy run never trips the $0 usage-limit banner.
    costUsd: 0.42,
    usage: { inputTokens: 12_000, outputTokens: 3_000 },
  };
}

/** A completed run where the security lens errored — the degraded signal: the
 *  logic lens finished, security did not, so the review is incomplete. */
function degradedStream(): ReviewStream {
  return {
    ...completedStream(),
    runId: 'run-3',
    lensState: { security: 'error', logic: 'done' },
    findings: [finding({ id: 'f2', lens: 'logic', severity: 'medium', line: null })],
  };
}

/** A completed run that spent $0 with zero input tokens — the usage-limit
 *  signature (every lens session refused before any billable work). */
function usageLimitStream(): ReviewStream {
  return {
    ...completedStream(),
    runId: 'run-4',
    findings: [],
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function runningStream(): ReviewStream {
  return {
    ...EMPTY_REVIEW_STREAM,
    runId: 'run-2',
    status: 'running',
    prNumber: 128,
    requestedLenses: LENSES,
    lensState: { ...seedStepState(LENSES), security: 'running' },
  };
}

const TOOLBAR: ReviewSectionToolbarSlice = {
  openCount: 2,
  onConvertAll: fn(),
  bulkConverting: false,
  bulkProgress: { done: 0, total: 0, failed: 0 },
  bulkStatusMessage: '',
  bulkError: null,
  selectedCount: 1,
  canPost: true,
  requestPost: fn(),
  ownPr: false,
  postedFeedback: null,
  addressCount: 1,
  canAddress: true,
  fixRunning: false,
  requestAddress: fn(),
  addressError: null,
};

const TIMELINE: TimelineStep[] = [
  { id: 'review', label: 'Reviewed', state: 'done', at: 1_700_000_000_000 },
  { id: 'posted', label: 'Posted to GitHub', state: 'done', at: 1_700_000_600_000 },
];

function fixState(over: Partial<PrFixState> = {}): PrFixState {
  return {
    id: 'prfix-1',
    kind: 'findings',
    runId: 'run-1',
    prNumber: 128,
    branch: 'fix/token-logging',
    dir: '/repo/.nightcore/pr-fix/pr-128',
    status: 'running',
    summary: null,
    error: null,
    findingCount: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function fixSlice(over: Partial<PrFixState> = {}): FixRunCardProps {
  return {
    fix: fixState(over),
    pushing: false,
    onCancel: fn(),
    onRequestPush: fn(),
    onReReview: fn(),
    onDismiss: fn(),
  };
}

const HISTORY: ReviewSectionHistorySlice = {
  items: [
    { label: '7/2/2026, 10:12:00 AM · 2 findings', onClick: fn() },
    { label: '7/1/2026, 4:03:00 PM · 5 findings', onClick: fn() },
  ],
  viewingPastRun: false,
  onBackToLatest: fn(),
};

/** Instantiate a live run-config so the chips/gate render as in the app. */
function ConfiguredSection({
  mode,
  stream,
  toolbar = TOOLBAR,
  history = HISTORY,
  startError = null,
  ownPr = false,
  fix = null,
  timeline = [],
  emptyVariant = 'clean',
}: {
  mode: ReviewSectionMode;
  stream: ReviewStream | null;
  toolbar?: ReviewSectionToolbarSlice;
  history?: ReviewSectionHistorySlice;
  startError?: string | null;
  ownPr?: boolean;
  fix?: FixRunCardProps | null;
  timeline?: TimelineStep[];
  emptyVariant?: 'clean' | 'neutral';
}) {
  const config = useRunConfig<ReviewLens>(ALL_LENSES, false);
  return (
    <ReviewSection
      prNumber={128}
      mode={mode}
      stream={stream}
      configure={{
        config,
        deep: false,
        onToggleDeep: fn(),
        isStarting: false,
        startError,
        onReview: fn(),
        onBackToResults: null,
      }}
      running={{
        categories: (stream?.requestedLenses ?? []).map((l) => ({
          key: l,
          label: LENS_META[l].label,
          icon: LENS_META[l].icon,
        })),
        findingCounts: {},
        lensRounds: {},
        onCancel: fn(),
      }}
      results={{
        gridFindings: stream?.findings ?? [],
        emptyMessage: 'The diff looks clean across the selected lenses.',
        emptyVariant,
        selection: new Set(['f1']),
        onToggleSelect: fn(),
        onSelectionChange: fn(),
        onOpenFinding: fn(),
        onNewReview: fn(),
        toolbar: { ...toolbar, ownPr },
        fix,
        timeline,
      }}
      history={history}
    />
  );
}

const meta = {
  title: 'PrReview/ReviewSection',
  component: ConfiguredSection,
  decorators: [
    (Story) => (
      <div className="w-[760px] p-5">
        <Story />
      </div>
    ),
  ],
  args: { mode: 'config' as ReviewSectionMode, stream: null },
} satisfies Meta<typeof ConfiguredSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Config: Story = {};

export const ConfigWithStartError: Story = {
  args: { startError: 'no pull request found for #128' },
};

export const Running: Story = {
  args: { mode: 'running', stream: runningStream() },
};

export const Completed: Story = {
  args: { mode: 'results', stream: completedStream() },
};

/** The viewer authored this PR: approve/request-changes disable (comment stays). */
export const CompletedOwnPr: Story = {
  args: { mode: 'results', stream: completedStream(), ownPr: true },
};

export const ViewingPastRun: Story = {
  args: {
    mode: 'results',
    stream: completedStream(),
    history: { ...HISTORY, viewingPastRun: true },
  },
};

/** Nothing selected: Address-findings (0) disables alongside the verdict gate. */
export const CompletedNothingSelected: Story = {
  args: {
    mode: 'results',
    stream: completedStream(),
    toolbar: {
      ...TOOLBAR,
      selectedCount: 0,
      canPost: false,
      addressCount: 0,
      canAddress: false,
    },
  },
};

/** A fix agent is running for this PR: the Address button disables (with the
 *  explanation) and the running strip renders above the grid. */
export const CompletedFixRunning: Story = {
  args: {
    mode: 'results',
    stream: completedStream(),
    toolbar: { ...TOOLBAR, canAddress: false, fixRunning: true },
    fix: fixSlice(),
  },
};

/** The fix finished and auto-committed — awaiting the human-gated push. */
export const CompletedFixAwaitingPush: Story = {
  args: {
    mode: 'results',
    stream: completedStream(),
    fix: fixSlice({
      status: 'awaiting_push',
      summary: 'Redacted the session token from the debug log.',
    }),
  },
};

/** The review-arc timeline renders atop the grid (reviewed → posted). */
export const CompletedWithTimeline: Story = {
  args: { mode: 'results', stream: completedStream(), timeline: TIMELINE },
};

/** Just after a successful post: the auto-clearing "Posted N findings" chip. */
export const CompletedJustPosted: Story = {
  args: {
    mode: 'results',
    stream: completedStream(),
    toolbar: { ...TOOLBAR, selectedCount: 0, canPost: false, postedFeedback: 2 },
  },
};

/** A completed run that surfaced nothing gets the celebratory clean empty state.
 *  Note it still spent tokens — so it is NOT the usage-limit case (no banner). */
export const CompletedClean: Story = {
  args: {
    mode: 'results',
    stream: { ...completedStream(), findings: [] },
    toolbar: { ...TOOLBAR, openCount: 0, selectedCount: 0, canPost: false, addressCount: 0, canAddress: false },
  },
};

/** A DEGRADED run: one lens errored, so the review is incomplete. The warning
 *  chip must appear so it never reads as a clean, full review (T10). */
export const CompletedDegraded: Story = {
  args: { mode: 'results', stream: degradedStream() },
};

/** The $0 / zero-token usage-limit signature: a "completed" run that spent
 *  nothing. The banner must appear so empty findings aren't misread as clean (T10). */
export const CompletedUsageLimit: Story = {
  args: {
    mode: 'results',
    stream: usageLimitStream(),
    toolbar: { ...TOOLBAR, openCount: 0, selectedCount: 0, canPost: false, addressCount: 0, canAddress: false },
  },
};
