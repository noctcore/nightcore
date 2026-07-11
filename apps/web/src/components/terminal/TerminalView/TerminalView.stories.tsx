import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';

import { ToastProvider } from '@/components/ui';
import type { WorktreeInfo } from '@/lib/bridge';
import { WorktreesProvider } from '@/lib/worktrees-context';

import { portaledSurface } from '../../../../.storybook/test-utils';
import { TerminalView } from './TerminalView';
import type { TerminalViewProps } from './TerminalView.types';

const WORKTREES: WorktreeInfo[] = [
  {
    branch: 'nc/api-client',
    path: '/Users/dev/nightcore/.nightcore/worktrees/t1',
    taskIds: ['t1'],
    dirty: true,
    aheadOfBase: 2,
    behindOfBase: 0,
    changedFiles: 3,
  },
  {
    branch: 'nc/auth-guard',
    path: '/Users/dev/nightcore/.nightcore/worktrees/t2',
    taskIds: ['t2'],
    dirty: false,
    aheadOfBase: 1,
    behindOfBase: 1,
    changedFiles: 0,
  },
];

/** The view reads worktrees from the shared context (like WorktreeView) and needs
 *  a ToastProvider for its error toasts. Worktrees stay a story arg so plays/tests
 *  can vary them. Outside Tauri `listTerminals` is empty, so the view lands on its
 *  empty state — opening a shell (which spawns a real echo xterm) is left to the
 *  component test + dogfood, not the story suite. */
function TerminalViewFixture({
  worktrees,
  ...props
}: TerminalViewProps & { worktrees: WorktreeInfo[] }) {
  return (
    <ToastProvider>
      <WorktreesProvider
        value={{
          worktrees,
          activeWorktree: null,
          setActiveWorktree: () => {},
          removeWorktree: () => {},
          refreshWorktrees: () => {},
        }}
      >
        <div style={{ height: 520, width: 780, display: 'flex' }}>
          <TerminalView {...props} />
        </div>
      </WorktreesProvider>
    </ToastProvider>
  );
}

const meta = {
  title: 'Terminal/TerminalView',
  component: TerminalViewFixture,
  parameters: { layout: 'fullscreen' },
  args: {
    worktrees: WORKTREES,
    projectPath: '/Users/dev/nightcore',
    projectName: 'nightcore',
    webglEnabled: false,
    confinedDefault: false,
    fontSize: null,
    scrollback: null,
    onConfinedDefaultChange: fn(),
  },
} satisfies Meta<typeof TerminalViewFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No sessions yet — the empty state invites opening a terminal. */
export const Empty: Story = {};

/** No project open — the empty state still renders; the picker would be target-less. */
export const NoProject: Story = { args: { projectPath: null, projectName: null } };

/** Play test: the empty-state CTA opens the picker, which lists the repo root and
 *  the worktrees (no shell is spawned — that path spawns a real echo terminal). */
export const OpensPicker: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Open a terminal' }));
    const surface = portaledSurface();
    await expect(surface.getByRole('heading', { name: 'Open a terminal' })).toBeInTheDocument();
    await expect(surface.getByRole('button', { name: /nc\/api-client/ })).toBeInTheDocument();
  },
};
