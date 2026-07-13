/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_TURNS,
  RETRY_REMINDER_ARRAY,
  RETRY_REMINDER_OBJECT,
} from './scan-contracts.js';

describe('scan tuning constants', () => {
  test('pool + turn defaults hold their audited budget values', () => {
    // These bound how many paid provider subprocesses a scan opens at once
    // (concurrency) and each pass's turn ceiling — a silent bump inflates cost, so
    // pin them as a regression guard on the shared budget.
    expect(DEFAULT_CONCURRENCY).toBe(6);
    expect(DEFAULT_MAX_TURNS).toBe(40);
  });

  test('corrective-retry reminders stay strict-JSON and shape-specific', () => {
    // The single corrective retry appends these; the wording must not drift per
    // feature (array-shaped vs object-shaped passes) or the retry stops steering the
    // model back to parseable output.
    expect(RETRY_REMINDER_ARRAY).toContain('JSON array');
    expect(RETRY_REMINDER_OBJECT).toContain('JSON object');
    expect(RETRY_REMINDER_ARRAY).not.toBe(RETRY_REMINDER_OBJECT);
  });
});
