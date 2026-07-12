/**
 * `SessionManager.handleQuery()`'s body, extracted verbatim (issue #232's
 * file-size ratchet — `session-manager.ts` is already at its frozen cap) so the
 * supervisor stays a thin dispatcher. Pure disk reads/writes via the SDK plus the
 * provider registry — no session runner involved, and no behavior change from the
 * inline version. Depends only on the collaborators `SessionManager` already owns,
 * threaded in as {@link SessionQueryDeps} instead of `this`.
 */
import type {
  ModelDescriptor,
  NightcoreEventOf,
  SurfaceQuery,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type { AgentSession } from '../providers/agent-provider.js';
import {
  toWireSessionInfo,
  toWireSessionMessage,
} from '../providers/claude/mappers.js';
import type { SessionApi } from '../providers/claude/session-api.js';
import type { ProviderRegistry } from '../providers/provider-factory.js';
import { validateRule } from '../rule-tester/validate-rule.js';

/** The collaborators a query answer needs — exactly what `SessionManager` already
 *  owns, so the supervisor's delegation is a straight field/method pass-through. */
export interface SessionQueryDeps {
  sessionApi: SessionApi;
  providers: ProviderRegistry;
  /** The dynamic model catalog (mirrors `SessionManager.listModels()`). */
  listModels: () => Promise<ModelDescriptor[]>;
  /** Any currently-live session, to piggyback its already-open query. */
  firstLiveRunner: () => AgentSession | undefined;
  /** A transient probe session (model list / provider-config inspection). */
  makeProbeSession: (providerId?: string) => AgentSession;
  logger?: Logger;
}

/**
 * Answer a `SurfaceQuery` against the SDK session store, returning the correlated
 * `query-result` event (which the sidecar emits through the same sink). The
 * `SessionApi` degrades-not-throws, so a read returns an empty/`ok: true` result
 * rather than rejecting; only a mutation that the SDK reported as failed sets
 * `ok: false`. The SDK return shapes are mapped to the camelCase wire types.
 */
export async function handleSessionQuery(
  deps: SessionQueryDeps,
  query: SurfaceQuery,
): Promise<NightcoreEventOf<'query-result'>> {
  const { requestId } = query;
  switch (query.type) {
    case 'list-sessions': {
      const sessions = await deps.sessionApi.listTaskSessions({
        ...(query.dir !== undefined ? { dir: query.dir } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.includeWorktrees !== undefined
          ? { includeWorktrees: query.includeWorktrees }
          : {}),
      });
      return {
        type: 'query-result',
        requestId,
        ok: true,
        kind: 'sessions',
        sessions: sessions.map(toWireSessionInfo),
      };
    }
    case 'get-session-info': {
      const info = await deps.sessionApi.getSessionInfoById(
        query.sdkSessionId,
        query.dir !== undefined ? { dir: query.dir } : {},
      );
      return {
        type: 'query-result',
        requestId,
        ok: true,
        kind: 'session-info',
        info: info !== undefined ? toWireSessionInfo(info) : null,
      };
    }
    case 'get-session-messages': {
      const messages = await deps.sessionApi.getTaskSessionMessages(
        query.sdkSessionId,
        {
          ...(query.dir !== undefined ? { dir: query.dir } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.includeSystemMessages !== undefined
            ? { includeSystemMessages: query.includeSystemMessages }
            : {}),
        },
      );
      return {
        type: 'query-result',
        requestId,
        ok: true,
        kind: 'messages',
        messages: messages.map(toWireSessionMessage),
      };
    }
    case 'rename-session': {
      const ok = await deps.sessionApi.renameTaskSession(
        query.sdkSessionId,
        query.title,
        query.dir !== undefined ? { dir: query.dir } : {},
      );
      return ok
        ? { type: 'query-result', requestId, ok: true, kind: 'ack' }
        : {
            type: 'query-result',
            requestId,
            ok: false,
            kind: 'ack',
            error: 'rename failed',
          };
    }
    case 'tag-session': {
      const ok = await deps.sessionApi.tagTaskSession(
        query.sdkSessionId,
        query.tag,
        query.dir !== undefined ? { dir: query.dir } : {},
      );
      return ok
        ? { type: 'query-result', requestId, ok: true, kind: 'ack' }
        : {
            type: 'query-result',
            requestId,
            ok: false,
            kind: 'ack',
            error: 'tag failed',
          };
    }
    case 'get-provider-config': {
      // The inspector reads RESOLVED, scope-aware config off a transient provider
      // probe rooted at the project dir (resolution keys off cwd). Reuse a live
      // session when one exists; else spin the input-less probe session — the
      // provider shares ONE subprocess and degrades per section, so the snapshot
      // always resolves (`ok: true`).
      const projectPath = query.dir ?? process.cwd();
      const session =
        query.providerId === undefined
          ? deps.firstLiveRunner() ?? deps.makeProbeSession()
          : deps.makeProbeSession(query.providerId);
      const providerConfig = await session.probeConfig(projectPath);
      return {
        type: 'query-result',
        requestId,
        ok: true,
        kind: 'provider-config',
        providerConfig,
      };
    }
    case 'get-capabilities': {
      // Provider-static: answer straight from the provider's descriptor (no probe,
      // no project dir), so the Rust core single-sources the truthful capability
      // matrix from the engine instead of duplicating it (issue #18).
      const provider = deps.providers.forSession(query.providerId);
      return {
        type: 'query-result',
        requestId,
        ok: true,
        kind: 'capabilities',
        capabilities: provider.capabilities(),
      };
    }
    case 'get-models': {
      // Provider-dynamic: the model catalog (ids + per-model effort levels) fetched
      // from the SDK at runtime, not hardcoded. Reuses a live session's query or
      // spins a transient probe; `listModels()` degrades to `[]` on any error, so
      // the reply is always `ok: true` (issue #80).
      return {
        type: 'query-result',
        requestId,
        ok: true,
        kind: 'models',
        models: await deps.listModels(),
      };
    }
    case 'validate-rule': {
      // One-shot RuleTester validation (issue #185): load the plugin rule
      // cross-toolchain and run it (or a structural probe) to confirm an armed
      // check is a real rule, not a placebo. `validateRule` is fail-SOFT — a load
      // failure is carried inside `outcome: 'error'`, so the reply stays `ok: true`.
      return {
        type: 'query-result',
        requestId,
        ok: true,
        kind: 'rule-validation',
        ruleValidation: await validateRule(query, deps.logger?.child('rule-tester')),
      };
    }
  }
}
