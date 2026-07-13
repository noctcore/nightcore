/**
 * Translate the SDK's task lifecycle system messages (`task_started` /
 * `task_updated` / `task_progress` / `task_notification`) into a single
 * `task-updated` NightcoreEvent. These events are NOT terminal — they describe
 * subagent/task progress, not the end of the session. Kept separate from the
 * main message translator because subagent task tracking is its own concern
 * with its own defensive-key-reading rules.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { NightcoreEvent } from '@nightcore/contracts';

import { getBoolean, getObject, getString } from '../../util/field-extract.js';

export type TaskUpdatedEvent = Extract<NightcoreEvent, { type: 'task-updated' }>;

/** Normalize the SDK's task-status superset onto the Nightcore
 *  `SubagentStepStatus` set. The only divergence is `'stopped'` (used by
 *  `task_notification`), which maps to `'killed'`; every other value already
 *  matches the contract enum. */
function normalizeTaskStatus(
  status: string | undefined,
): TaskUpdatedEvent['status'] {
  if (status === undefined) return undefined;
  if (status === 'stopped') return 'killed';
  if (
    status === 'pending' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'killed' ||
    status === 'paused' ||
    status === 'in_progress'
  ) {
    return status === 'in_progress' ? 'running' : status;
  }
  return undefined;
}

/**
 * Translate the SDK's task lifecycle system messages
 * (`task_started` / `task_updated` / `task_progress` / `task_notification`)
 * into a single `task-updated` event. Keys are read defensively because the SDK
 * marks most of them optional. Returns `undefined` for any other subtype so the
 * caller can fall through.
 *
 * These events are NOT terminal — they describe subagent/task progress, not the
 * end of the session.
 */
export function translateTask(
  sessionId: number,
  msg: Extract<SDKMessage, { type: 'system' }>,
): TaskUpdatedEvent | undefined {
  const m = msg as Record<string, unknown>;
  const taskId = getString(m, 'task_id');
  if (taskId === undefined) return undefined;

  const subagentType = getString(m, 'subagent_type');
  const description = getString(m, 'description');
  const summary = getString(m, 'summary');

  switch (msg.subtype) {
    case 'task_started': {
      const ambient = getBoolean(m, 'skip_transcript') ?? false;
      return {
        type: 'task-updated',
        sessionId,
        taskId,
        status: 'running',
        ...(description !== undefined ? { description } : {}),
        ...(subagentType !== undefined ? { subagentType } : {}),
        ambient,
      };
    }
    case 'task_updated': {
      const patch = getObject(m, 'patch') ?? {};
      const status = normalizeTaskStatus(getString(patch, 'status'));
      const patchDescription = getString(patch, 'description');
      const patchError = getString(patch, 'error');
      return {
        type: 'task-updated',
        sessionId,
        taskId,
        ...(status !== undefined ? { status } : {}),
        ...(patchDescription !== undefined
          ? { description: patchDescription }
          : {}),
        ...(patchError !== undefined ? { summary: patchError } : {}),
        ambient: false,
      };
    }
    case 'task_progress': {
      return {
        type: 'task-updated',
        sessionId,
        taskId,
        ...(description !== undefined ? { description } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(subagentType !== undefined ? { subagentType } : {}),
        ambient: false,
      };
    }
    case 'task_notification': {
      const status = normalizeTaskStatus(getString(m, 'status'));
      return {
        type: 'task-updated',
        sessionId,
        taskId,
        ...(status !== undefined ? { status } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ambient: false,
      };
    }
    default:
      return undefined;
  }
}
