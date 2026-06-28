/** Prop and data-seam types for the session-history list. */
import type { SessionInfo, SessionMessage } from '@/lib/bridge';

/** The injectable data seam — defaults to the real bridge in the live hook, but
 *  stories/tests pass in-memory loaders so the component renders without Tauri. */
export interface SessionHistoryData {
  loadSessions: (taskId: string) => Promise<SessionInfo[]>;
  loadMessages: (taskId: string, sdkSessionId: string) => Promise<SessionMessage[]>;
}

/** Props for the SessionHistory list. */
export interface SessionHistoryProps {
  /** The task whose SDK session history is shown. */
  taskId: string;
  /** The task's current resume target (`task.sdkSessionId`), so the row that
   *  matches is marked as the active/last session. `null` until the task has run. */
  currentSdkSessionId: string | null;
  /** Whether resume is allowed at all for this task right now (e.g. no other run is
   *  in flight). A per-row orphaned session is additionally non-resumable. */
  canResume: boolean;
  /** Resume a chosen session — relaunches the task pointed at this UUID. */
  onResume: (taskId: string, sdkSessionId: string) => void;
  /** Rename a session's title. */
  onRename: (sdkSessionId: string, title: string) => void;
  /** Tag a session, or clear its tag with `null`. */
  onTag: (sdkSessionId: string, tag: string | null) => void;
  /** Override the data seam (stories/tests). Defaults to the live bridge. */
  data?: SessionHistoryData;
}
