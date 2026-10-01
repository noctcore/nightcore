/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  AutonomyNotPermittedError,
  GovernanceNotSupportedError,
} from '../providers/agent-provider.js';
import { refusalEvent } from './session-preflight-refusal.js';

describe('refusalEvent — preflight refusal → terminal session-failed', () => {
  test('maps an autonomy refusal to session-failed', () => {
    const event = refusalEvent(
      7,
      new AutonomyNotPermittedError('fake', 'bypass'),
      undefined,
    );
    expect(event).not.toBeNull();
    expect(event?.type).toBe('session-failed');
    expect(event?.sessionId).toBe(7);
    expect(event?.reason).toBe('runner-crash');
  });

  test('maps a governance refusal to session-failed', () => {
    const event = refusalEvent(
      8,
      new GovernanceNotSupportedError('fake'),
      undefined,
    );
    expect(event?.type).toBe('session-failed');
  });

  test('returns null for a NON-refusal error so the caller rethrows', () => {
    expect(refusalEvent(10, new Error('some other crash'), undefined)).toBeNull();
    expect(refusalEvent(11, new TypeError('boom'), undefined)).toBeNull();
  });
});
