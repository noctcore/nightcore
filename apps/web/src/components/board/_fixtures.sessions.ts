import type { SessionInfo, SessionMessage } from '@/lib/bridge';

/** A task's SDK session history for the SessionHistory stories/tests: a live-cwd
 *  session (resumable), an orphaned one (worktree pruned → view-only), and one
 *  with a custom title + tag. Mirrors the `list_task_sessions` view shape. */
export const SESSIONS: SessionInfo[] = [
  {
    sdkSessionId: 'sdk-uuid-live',
    summary: 'Wire up the auth guard middleware',
    lastModified: 1_718_900_000_000,
    fileSize: 8192,
    customTitle: null,
    firstPrompt: 'Add an auth guard to the protected routes',
    gitBranch: 'nc/auth-guard',
    cwd: '/dev/nightcore/.nightcore/worktrees/auth-guard',
    tag: null,
    createdAt: 1_718_800_000_000,
    orphaned: false,
  },
  {
    sdkSessionId: 'sdk-uuid-orphan',
    summary: 'Earlier exploration run',
    lastModified: 1_718_700_000_000,
    fileSize: 4096,
    customTitle: null,
    firstPrompt: 'Explore the routing layer',
    gitBranch: 'nc/auth-guard',
    cwd: '/dev/nightcore/.nightcore/worktrees/gone',
    tag: null,
    createdAt: 1_718_600_000_000,
    orphaned: true,
  },
  {
    sdkSessionId: 'sdk-uuid-tagged',
    summary: 'First draft of the guard',
    lastModified: 1_718_500_000_000,
    fileSize: 2048,
    customTitle: 'Guard v1 (keep)',
    firstPrompt: 'Draft the guard',
    gitBranch: 'nc/auth-guard',
    cwd: '/dev/nightcore/.nightcore/worktrees/auth-guard',
    tag: 'keep',
    createdAt: 1_718_400_000_000,
    orphaned: false,
  },
];

/** A short transcript for a session, for the SessionHistory expand/view stories. */
export const SESSION_MESSAGES: SessionMessage[] = [
  {
    type: 'user',
    uuid: 'msg-1',
    sessionId: 'sdk-uuid-live',
    message: { role: 'user', content: 'Add an auth guard to the protected routes.' },
    parentToolUseId: null,
  },
  {
    type: 'assistant',
    uuid: 'msg-2',
    sessionId: 'sdk-uuid-live',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll add a `requireAuth` middleware and apply it to the router." },
      ],
    },
    parentToolUseId: null,
  },
];
