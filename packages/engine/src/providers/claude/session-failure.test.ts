/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { CLAUDE_CLI_MISSING_MESSAGE, sessionFailedEvent } from './session-failure.js';

describe('CLAUDE_CLI_MISSING_MESSAGE', () => {
  test('names the install command and the setup docs so the failure is actionable', () => {
    expect(CLAUDE_CLI_MISSING_MESSAGE).toContain('Claude CLI not found');
    expect(CLAUDE_CLI_MISSING_MESSAGE).toContain('https://code.claude.com/docs/en/setup');
    // The platform-appropriate installer (this test process is not win32 in CI).
    expect(CLAUDE_CLI_MISSING_MESSAGE).toContain(
      process.platform === 'win32'
        ? 'irm https://claude.ai/install.ps1 | iex'
        : 'curl -fsSL https://claude.ai/install.sh | bash',
    );
  });
});

describe('sessionFailedEvent', () => {
  test('threads sessionId/reason/message and attaches the structured detail', () => {
    const event = sessionFailedEvent(42, 'runner-crash', 'boom');
    expect(event).toEqual({
      type: 'session-failed',
      sessionId: 42,
      reason: 'runner-crash',
      message: 'boom',
      // A runner crash is retriable and buckets to its own category.
      detail: { category: 'runner-crash', message: 'boom', retriable: true },
    });
  });

  test('an aborted failure is non-retriable', () => {
    const event = sessionFailedEvent(1, 'aborted', 'user interrupted');
    expect(event.reason).toBe('aborted');
    expect(event.detail).toEqual({
      category: 'aborted',
      message: 'user interrupted',
      retriable: false,
    });
  });

  test('an ENOSPC message promotes a runner-crash to the non-retriable disk-full bucket', () => {
    const event = sessionFailedEvent(2, 'runner-crash', 'ENOSPC: no space left on device');
    expect(event.detail?.category).toBe('disk-full');
    expect(event.detail?.retriable).toBe(false);
  });
});
