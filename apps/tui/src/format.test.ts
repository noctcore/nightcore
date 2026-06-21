/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { formatDuration, formatTokens, formatUsage } from './format.js';

describe('formatTokens', () => {
  test('passes through sub-1k counts', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(980)).toBe('980');
  });
  test('compacts thousands to one decimal', () => {
    expect(formatTokens(12345)).toBe('12.3k');
    expect(formatTokens(4500)).toBe('4.5k');
  });
});

describe('formatDuration', () => {
  test('seconds with one decimal under a minute', () => {
    expect(formatDuration(820)).toBe('0.8s');
    expect(formatDuration(3210)).toBe('3.2s');
  });
  test('minutes and zero-padded seconds at/over a minute', () => {
    expect(formatDuration(92_000)).toBe('1m32s');
    expect(formatDuration(60_000)).toBe('1m00s');
  });
});

describe('formatUsage', () => {
  test('arrows for input/output', () => {
    expect(
      formatUsage({
        inputTokens: 12300,
        outputTokens: 4500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe('↑12.3k ↓4.5k');
  });
  test('appends cache reads only when present', () => {
    expect(
      formatUsage({
        inputTokens: 12300,
        outputTokens: 4500,
        cacheReadTokens: 8000,
        cacheCreationTokens: 0,
      }),
    ).toBe('↑12.3k ↓4.5k (+8.0k cache)');
  });
});
