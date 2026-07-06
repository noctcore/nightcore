import { describe, expect, test } from 'bun:test';

import { CHANNELS } from './channels.js';

describe('CHANNELS is the single nc:* channel registry', () => {
  test('every channel name is a distinct `nc:`-prefixed string', () => {
    const names = Object.values(CHANNELS);
    for (const name of names) {
      expect(name.startsWith('nc:')).toBe(true);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  test('the registry matches the exact wire contract (rename tripwire)', () => {
    // This mirrors what the Rust `contracts/mod.rs` conformance test asserts
    // against its scattered `*_EVENT` consts. Renaming a channel here without
    // updating that const (and vice versa) reds `cargo test`; changing this
    // expected map is the deliberate, reviewed way to rename a channel.
    expect(CHANNELS).toEqual({
      session: 'nc:session',
      permission: 'nc:permission',
      question: 'nc:question',
      task: 'nc:task',
      project: 'nc:project',
      loop: 'nc:loop',
      insight: 'nc:insight',
      harness: 'nc:harness',
      scorecard: 'nc:scorecard',
      prReview: 'nc:pr-review',
      issueTriage: 'nc:issue-triage',
      prFix: 'nc:pr-fix',
    });
  });
});
