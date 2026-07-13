/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  categoryForReason,
  detailForReason,
  mapAssistantError,
} from './sdk-error-classification.js';

describe('mapAssistantError', () => {
  type Reason = ReturnType<typeof mapAssistantError>;
  const cases: ReadonlyArray<readonly [string | undefined, Reason]> = [
    ['authentication_failed', 'authentication'],
    ['oauth_org_not_allowed', 'authentication'],
    ['rate_limit', 'rate-limit'],
    ['overloaded', 'rate-limit'],
    ['max_output_tokens', 'max-turns'],
    ['server_error', 'unknown'],
    [undefined, 'unknown'],
  ];
  test.each(cases)('maps %p to %p', (input, expected) => {
    expect(mapAssistantError(input)).toBe(expected);
  });
});

describe('categoryForReason — structured error taxonomy', () => {
  const cases: ReadonlyArray<
    readonly [Parameters<typeof categoryForReason>[0], string, string]
  > = [
    ['authentication', 'no', 'auth'],
    ['rate-limit', 'slow down', 'rate-limit'],
    ['aborted', 'cancelled', 'aborted'],
    ['max-turns', 'cap', 'resource-exhausted'],
    ['max-budget', 'cap', 'resource-exhausted'],
    ['runner-crash', 'boom', 'runner-crash'],
    ['unknown', 'huh', 'unknown'],
    // A generic crash/unknown is promoted to disk-full when the OS said ENOSPC.
    ['runner-crash', 'write failed: ENOSPC', 'disk-full'],
    ['unknown', 'no space left on device', 'disk-full'],
  ];
  test.each(cases)('%p (%p) → %p', (reason, message, expected) => {
    expect(categoryForReason(reason, message)).toBe(expected);
  });
});

describe('detailForReason — retriability', () => {
  test('marks rate-limit and runner-crash retriable', () => {
    expect(detailForReason('rate-limit', 'x').retriable).toBe(true);
    expect(detailForReason('runner-crash', 'boom').retriable).toBe(true);
  });
  test('marks auth, resource ceilings, and disk-full non-retriable', () => {
    expect(detailForReason('authentication', 'x').retriable).toBe(false);
    expect(detailForReason('max-turns', 'x').retriable).toBe(false);
    expect(detailForReason('runner-crash', 'ENOSPC').category).toBe('disk-full');
    expect(detailForReason('runner-crash', 'ENOSPC').retriable).toBe(false);
  });
});
