/**
 * Read-only access to the Claude Agent SDK's on-disk session store: list a
 * project's sessions, read a single session's metadata, and read a session's
 * transcript — plus the two mutations (rename / tag). The SDK persists every run
 * as a resumable JSONL under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, so
 * these functions surface that history without Nightcore re-persisting anything.
 *
 * House rules this module follows:
 *  - The SDK is imported only through `sdk-adapter.ts` (the one boundary file).
 *  - Every wrapper degrades-not-throws: a read returns `[]`/`undefined` and a
 *    mutation returns `false` on any error (logged at debug), matching the
 *    engine's graceful-degradation style — a missing/locked session file can
 *    never reject a UI query.
 *
 * The `dir` semantics are load-bearing (mirroring the SDK):
 *  - OMIT `dir` to search ALL project dirs by UUID — the only PRUNE-SAFE read
 *    path (a worktree-keyed session survives its worktree being pruned).
 *  - PASS `dir` (a project root, `includeWorktrees: true`) to discover sibling
 *    sessions that still have a live worktree.
 */
import type { Logger } from '@nightcore/shared';

import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  type SDKSessionInfo,
  type SessionMessage,
  tagSession,
} from './sdk-adapter.js';

export type { SDKSessionInfo, SessionMessage };

/** Options for [`listTaskSessions`]. `dir` scopes the project-dir search (omit ⇒
 *  search all). `includeWorktrees` (default true on the SDK) fans a `dir`-scoped
 *  list out to every live git worktree under it. */
export interface ListTaskSessionsOptions {
  dir?: string;
  limit?: number;
  offset?: number;
  includeWorktrees?: boolean;
}

/** Options for [`getTaskSessionMessages`]. */
export interface GetTaskSessionMessagesOptions {
  dir?: string;
  limit?: number;
  offset?: number;
  includeSystemMessages?: boolean;
}

/**
 * The engine's thin session-API surface. Each method wraps one SDK session
 * function and degrades-not-throws. Stateless aside from an optional logger, so
 * a caller can construct one per request or reuse a singleton.
 */
export class SessionApi {
  constructor(private readonly logger?: Logger) {}

  /**
   * List the SDK sessions visible for `options.dir` (omit ⇒ all project dirs).
   * With a `dir` inside a git repo and `includeWorktrees: true` this surfaces
   * every live-worktree session under it. Degrades to `[]` on any error — a
   * pruned-worktree session simply won't appear here (resolve it by UUID via
   * [`getSessionInfoById`] instead). */
  async listTaskSessions(
    options: ListTaskSessionsOptions = {},
  ): Promise<SDKSessionInfo[]> {
    try {
      return await listSessions(options);
    } catch (error) {
      this.logger?.debug('listSessions() failed; returning empty list', error);
      return [];
    }
  }

  /**
   * Read one session's metadata by UUID. Omit `dir` to search ALL project dirs
   * (the prune-safe path: finds the file even after its worktree is gone).
   * Returns `undefined` when the session is not found / has no summary, or on any
   * error. */
  async getSessionInfoById(
    sdkSessionId: string,
    options: { dir?: string } = {},
  ): Promise<SDKSessionInfo | undefined> {
    try {
      return await getSessionInfo(sdkSessionId, options);
    } catch (error) {
      this.logger?.debug('getSessionInfo() failed; returning undefined', error);
      return undefined;
    }
  }

  /**
   * Read one session's transcript messages by UUID. Omit `dir` to search ALL
   * project dirs (the prune-safe read: an orphaned session's transcript stays
   * viewable). Degrades to `[]` on any error. */
  async getTaskSessionMessages(
    sdkSessionId: string,
    options: GetTaskSessionMessagesOptions = {},
  ): Promise<SessionMessage[]> {
    try {
      return await getSessionMessages(sdkSessionId, options);
    } catch (error) {
      this.logger?.debug('getSessionMessages() failed; returning empty list', error);
      return [];
    }
  }

  /** Rename a session (appends a custom-title entry to its JSONL). Omit `dir` to
   *  search all project dirs. Returns whether the rename succeeded. */
  async renameTaskSession(
    sdkSessionId: string,
    title: string,
    options: { dir?: string } = {},
  ): Promise<boolean> {
    try {
      await renameSession(sdkSessionId, title, options);
      return true;
    } catch (error) {
      this.logger?.debug('renameSession() failed', error);
      return false;
    }
  }

  /** Tag a session, or clear its tag when `tag` is `null`. Omit `dir` to search
   *  all project dirs. Returns whether the tag write succeeded. */
  async tagTaskSession(
    sdkSessionId: string,
    tag: string | null,
    options: { dir?: string } = {},
  ): Promise<boolean> {
    try {
      await tagSession(sdkSessionId, tag, options);
      return true;
    } catch (error) {
      this.logger?.debug('tagSession() failed', error);
      return false;
    }
  }
}
