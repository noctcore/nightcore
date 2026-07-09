/**
 * The SDK→wire mappers for the Claude provider. They translate the drift-prone SDK
 * shapes (`ModelInfo`, `SDKSessionInfo`, `SessionMessage`) into the contract wire
 * types the supervisor forwards, so no SDK type name crosses the provider boundary.
 * Pure, so each is unit-testable without spinning a live query. Relocated here from
 * `session-manager` (issue #18) to keep the supervisor SDK-type-free.
 */
import type {
  ModelDescriptor,
  SessionInfo,
  SessionMessage as WireSessionMessage,
} from '@nightcore/contracts';

import type { ModelInfo } from './sdk-adapter.js';
import type { SDKSessionInfo, SessionMessage } from './session-api.js';

/**
 * Map an SDK `ModelInfo` to a contract `ModelDescriptor`. The SDK marks
 * `supportsEffort` / `supportedEffortLevels` optional; default to the
 * most-conservative values.
 */
export function toModelDescriptor(info: ModelInfo): ModelDescriptor {
  return {
    providerId: 'claude',
    value: info.value,
    displayName: info.displayName,
    description: info.description,
    supportsEffort: info.supportsEffort ?? false,
    supportedEffortLevels: info.supportedEffortLevels ?? [],
  };
}

/** Map the SDK's `SDKSessionInfo` onto the contract `SessionInfo`, renaming
 *  `sessionId` → `sdkSessionId` (the wire vocabulary) and forwarding the rest
 *  field-for-field. Optional fields are omitted when absent to match the
 *  `.optional()` wire shape. */
export function toWireSessionInfo(info: SDKSessionInfo): SessionInfo {
  return {
    sdkSessionId: info.sessionId,
    summary: info.summary,
    lastModified: info.lastModified,
    ...(info.fileSize !== undefined ? { fileSize: info.fileSize } : {}),
    ...(info.customTitle !== undefined ? { customTitle: info.customTitle } : {}),
    ...(info.firstPrompt !== undefined ? { firstPrompt: info.firstPrompt } : {}),
    ...(info.gitBranch !== undefined ? { gitBranch: info.gitBranch } : {}),
    ...(info.cwd !== undefined ? { cwd: info.cwd } : {}),
    ...(info.tag !== undefined ? { tag: info.tag } : {}),
    ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
  };
}

/** Map the SDK's `SessionMessage` (snake_case, `message: unknown`) onto the contract
 *  `SessionMessage` (camelCase wire keys, `message` as an object record). A
 *  non-object `message` is coerced to an empty record so a malformed transcript line
 *  can't violate the contract. `parent_tool_use_id` is `string | null`. */
export function toWireSessionMessage(msg: SessionMessage): WireSessionMessage {
  const message =
    typeof msg.message === 'object' && msg.message !== null
      ? (msg.message as Record<string, unknown>)
      : {};
  return {
    type: msg.type,
    uuid: msg.uuid,
    sessionId: msg.session_id,
    message,
    parentToolUseId: msg.parent_tool_use_id,
  };
}
