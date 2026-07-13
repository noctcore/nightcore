/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { translateTask } from './sdk-task-events.js';

const SID = 7;

/** Minimal SDK system-message fixtures. `translateTask` is defensive and reads
 *  only a handful of fields, so we cast partial shapes through `unknown`. */
function sdk(msg: Record<string, unknown>): Extract<SDKMessage, { type: 'system' }> {
  return msg as unknown as Extract<SDKMessage, { type: 'system' }>;
}

describe('translateTask — task lifecycle system messages', () => {
  test('maps task_started to a running task-updated (ambient from skip_transcript)', () => {
    const event = translateTask(
      SID,
      sdk({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        description: 'Investigating the auth flow',
        subagent_type: 'Explore',
        skip_transcript: true,
      }),
    );
    expect(event).toEqual({
      type: 'task-updated',
      sessionId: SID,
      taskId: 'task-1',
      status: 'running',
      description: 'Investigating the auth flow',
      subagentType: 'Explore',
      ambient: true,
    });
  });

  test('defaults ambient to false when skip_transcript is absent', () => {
    const event = translateTask(
      SID,
      sdk({ type: 'system', subtype: 'task_started', task_id: 'task-2', description: 'go' }),
    );
    expect(event?.ambient).toBe(false);
    expect(event?.subagentType).toBeUndefined();
  });

  test('maps task_updated patch (status + error → summary)', () => {
    const event = translateTask(
      SID,
      sdk({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-3',
        patch: { status: 'failed', description: 'retrying', error: 'boom' },
      }),
    );
    expect(event).toEqual({
      type: 'task-updated',
      sessionId: SID,
      taskId: 'task-3',
      status: 'failed',
      description: 'retrying',
      summary: 'boom',
      ambient: false,
    });
  });

  test('maps task_progress (description + summary + subagent, no status)', () => {
    const event = translateTask(
      SID,
      sdk({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-4',
        description: 'still working',
        summary: 'half done',
        subagent_type: 'builder',
      }),
    );
    expect(event?.status).toBeUndefined();
    expect(event).toMatchObject({
      taskId: 'task-4',
      description: 'still working',
      summary: 'half done',
      subagentType: 'builder',
      ambient: false,
    });
  });

  test('maps task_notification stopped → killed', () => {
    const event = translateTask(
      SID,
      sdk({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-5',
        status: 'stopped',
        summary: 'user cancelled',
      }),
    );
    expect(event).toEqual({
      type: 'task-updated',
      sessionId: SID,
      taskId: 'task-5',
      status: 'killed',
      summary: 'user cancelled',
      ambient: false,
    });
  });

  test('maps task_notification completed as-is', () => {
    const event = translateTask(
      SID,
      sdk({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-6',
        status: 'completed',
        summary: 'done',
      }),
    );
    expect(event?.status).toBe('completed');
  });

  test('ignores a task subtype with no task_id', () => {
    const event = translateTask(
      SID,
      sdk({ type: 'system', subtype: 'task_progress', description: 'orphan' }),
    );
    expect(event).toBeUndefined();
  });
});
