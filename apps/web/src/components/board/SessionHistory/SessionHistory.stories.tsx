import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { SESSION_MESSAGES, SESSIONS } from '../_fixtures.sessions';
import { SessionHistory } from './SessionHistory';
import type { SessionHistoryData } from './SessionHistory.types';

/** A static in-memory data seam so the stories render without Tauri. */
const mockData: SessionHistoryData = {
  loadSessions: () => Promise.resolve(SESSIONS),
  loadMessages: () => Promise.resolve(SESSION_MESSAGES),
};

const emptyData: SessionHistoryData = {
  loadSessions: () => Promise.resolve([]),
  loadMessages: () => Promise.resolve([]),
};

const meta = {
  title: 'Board/SessionHistory',
  component: SessionHistory,
  args: {
    taskId: 'task-1',
    currentSdkSessionId: 'sdk-uuid-live',
    canResume: true,
    onResume: fn(),
    onRename: fn(),
    onTag: fn(),
    data: mockData,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 440, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionHistory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default history: a resumable session, an orphaned one (Resume hidden), and
 *  a tagged/custom-titled session. */
export const Default: Story = {};

/** No past sessions yet — the empty state. */
export const Empty: Story = {
  args: { data: emptyData },
};

/** Resume disabled at the task level (e.g. another run in flight): no row offers
 *  Resume even for a live-cwd session. */
export const ResumeDisabled: Story = {
  args: { canResume: false },
};

/** Play test: clicking Resume on the live session fires onResume(taskId, uuid). */
export const ResumesLiveSession: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText(/Wire up the auth guard/)).toBeInTheDocument());
    const resumeButtons = await canvas.findAllByRole('button', { name: /resume session/i });
    await userEvent.click(resumeButtons[0]!);
    await expect(args.onResume).toHaveBeenCalledWith('task-1', 'sdk-uuid-live');
  },
};

/** Play test: expanding a row lazy-loads and shows its transcript. */
export const ViewsTranscript: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText(/Wire up the auth guard/)).toBeInTheDocument());
    await userEvent.click(canvas.getByText(/Wire up the auth guard/));
    // The assistant turn renders via markdown (a backtick span splits the text),
    // so assert on a stable plain-text fragment of the message.
    await waitFor(() =>
      expect(canvas.getByText(/apply it to the router/i)).toBeInTheDocument(),
    );
  },
};
