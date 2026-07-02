import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { PrReviewComments as PrReviewCommentsPayload } from '@/lib/bridge';

import { makePrReviewComments, makeTask } from '../_fixtures';
import { PrReviewComments } from './PrReviewComments';
import type { PrReviewCommentsView } from './PrReviewComments.hooks';

/** The canonical PR'd task: a done + verified + committed worktree task whose PR
 *  exists but is not yet merged locally. */
const PR_TASK = makeTask({
  id: 't-pr',
  status: 'done',
  title: 'Wire up auth guard',
  branch: 'nc/auth-guard',
  runMode: 'worktree',
  verified: true,
  committed: true,
  prUrl: 'https://github.com/acme/nightcore/pull/123',
  prNumber: 123,
});

/** Build the LIFTED view a story renders from (the component never self-fetches
 *  — TaskDetail owns `usePrReviewComments`). `null` payload = the unavailable
 *  browser-preview note. */
function view(
  comments: PrReviewCommentsPayload | null,
  extra: Partial<PrReviewCommentsView> = {},
): PrReviewCommentsView {
  return {
    comments,
    fetching: false,
    error: null,
    unavailable: comments === null,
    refreshedAt: 1_718_900_000_000,
    refresh: fn(),
    ...extra,
  };
}

const meta = {
  title: 'Board/PrReviewComments',
  component: PrReviewComments,
  args: {
    task: PR_TASK,
    view: view(makePrReviewComments()),
    onAddressComments: fn(async () => {}),
  },
  decorators: [
    (Story) => (
      <div style={{ width: '26rem', padding: '1rem' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PrReviewComments>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One unresolved inline thread + one changes-requested review summary. */
export const WithComments: Story = {};

/** An outdated inline thread (its anchor line moved) — a muted "outdated" badge. */
export const OutdatedThread: Story = {
  args: {
    view: view(
      makePrReviewComments({
        threads: [
          {
            path: 'src/auth/guard.ts',
            line: null,
            isOutdated: true,
            comments: [{ author: 'octo-reviewer', body: 'This block was rewritten upstream.' }],
          },
        ],
        reviews: [],
      }),
    ),
  },
};

/** A file-level thread (no line) and a detached thread (no path → `(general)`),
 *  plus a multi-comment thread. */
export const MultipleThreads: Story = {
  args: {
    view: view(
      makePrReviewComments({
        threads: [
          {
            path: 'src/api/client.ts',
            line: null,
            isOutdated: false,
            comments: [
              { author: 'octo-reviewer', body: 'The whole module needs error handling.' },
              { author: 'second-reviewer', body: 'Agreed — wrap the fetch in a try/catch.' },
            ],
          },
          {
            path: null,
            line: null,
            isOutdated: false,
            comments: [{ author: 'octo-reviewer', body: 'General: add a CHANGELOG entry.' }],
          },
        ],
        reviews: [],
      }),
    ),
  },
};

/** Top-level review summaries only, exercising the state badges (approved +
 *  commented + unknown gh vocabulary degrading to raw). */
export const ReviewSummaries: Story = {
  args: {
    view: view(
      makePrReviewComments({
        threads: [],
        reviews: [
          { author: 'octo-reviewer', state: 'APPROVED', body: 'Looks great, one nit inline.' },
          { author: 'second-reviewer', state: 'COMMENTED', body: 'Left a couple of questions.' },
          { author: 'bot-reviewer', state: 'ESCALATED', body: 'Escalated for a security look.' },
        ],
      }),
    ),
  },
};

/** No unresolved comments — the quiet empty note; Address is present but disabled. */
export const Empty: Story = {
  args: { view: view(makePrReviewComments({ threads: [], reviews: [] })) },
};

/** A fetch in flight — the Refresh button disables and shows a spinner. */
export const Fetching: Story = {
  args: { view: view(null, { fetching: true, unavailable: false, refreshedAt: null }) },
};

/** The browser-preview degrade: no Tauri, a null payload — a quiet note. */
export const Unavailable: Story = {
  args: { view: view(null) },
};

/** A remote-merged task — Address is disabled (there is nothing left to fix). */
export const MergedTask: Story = {
  args: { task: makeTask({ ...PR_TASK, merged: true }) },
};

/** A fetch failure — the error rides inline beside the last good payload. */
export const FetchError: Story = {
  args: {
    view: view(makePrReviewComments(), { error: 'gh: could not reach the GitHub API' }),
  },
};

/** Play test: Address is confirm-gated — the dialog names the count, and the
 *  handler only fires from its confirm (scoped to the dialog). */
export const AddressConfirmGate: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Address comments' }));
    await expect(args.onAddressComments).not.toHaveBeenCalled();
    const dialog = within(canvas.getByRole('alertdialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Address comments' }));
    await expect(args.onAddressComments).toHaveBeenCalledWith('t-pr');
  },
};
