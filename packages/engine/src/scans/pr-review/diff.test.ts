/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { capDiff, MAX_DIFF_BYTES } from './diff.js';

describe('capDiff', () => {
  test('leaves a small diff untouched', () => {
    const diff = 'diff --git a/x.ts b/x.ts\n@@\n+ ok();';
    expect(capDiff(diff)).toBe(diff);
  });

  test('leaves a diff exactly at the ceiling untouched', () => {
    const diff = 'a'.repeat(MAX_DIFF_BYTES);
    expect(capDiff(diff)).toBe(diff);
    expect(capDiff(diff)).not.toContain('[diff truncated');
  });

  test('truncates an oversized diff and appends a visible marker', () => {
    const diff = 'a'.repeat(MAX_DIFF_BYTES + 5000);
    const capped = capDiff(diff);
    expect(capped).toContain('[diff truncated at');
    // The kept material precedes the marker, and the whole thing is shorter than input.
    expect(capped.length).toBeLessThan(diff.length);
    expect(capped.startsWith('a'.repeat(1000))).toBe(true);
  });

  test('keeps the retained diff bytes at or under the ceiling', () => {
    const diff = 'z'.repeat(MAX_DIFF_BYTES * 2);
    const capped = capDiff(diff);
    const kept = capped.slice(0, capped.indexOf('\n… [diff truncated'));
    expect(Buffer.byteLength(kept, 'utf8')).toBeLessThanOrEqual(MAX_DIFF_BYTES);
  });
});
