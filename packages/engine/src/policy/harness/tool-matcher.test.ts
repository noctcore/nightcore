/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';

import type { Logger } from '@nightcore/shared';

import { compileToolMatcher, toolMatches } from './tool-matcher.js';

function fakeLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  } as unknown as Logger;
}

describe('compileToolMatcher — exact entries', () => {
  test('an exact entry matches only its own name', () => {
    const matcher = compileToolMatcher(['mcp__acme__push'], 'disallowedTools');
    expect(toolMatches(matcher, 'mcp__acme__push')).toBe(true);
    expect(toolMatches(matcher, 'mcp__acme__pull')).toBe(false);
  });

  test('empty/whitespace entries are warn-and-skipped, not fatal', () => {
    const logger = fakeLogger();
    const matcher = compileToolMatcher(['', '  ', 'WebSearch'], 'disallowedTools', logger);
    expect(matcher.exact.size).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('compileToolMatcher — mcp__server__* prefix globs (#223)', () => {
  test('an mcp__server__* entry gates every tool from that server', () => {
    const matcher = compileToolMatcher(['mcp__acme__*'], 'disallowedTools');
    // A tool the entry never enumerated is still gated by the server glob.
    expect(toolMatches(matcher, 'mcp__acme__anytool')).toBe(true);
    // A different server, and a native tool, are untouched.
    expect(toolMatches(matcher, 'mcp__other__push')).toBe(false);
    expect(toolMatches(matcher, 'WebSearch')).toBe(false);
    // The glob is a prefix, not an exact entry.
    expect(matcher.exact.size).toBe(0);
    expect(matcher.prefixes).toEqual(['mcp__acme__']);
  });

  test('a non-mcp entry, even with a trailing *, is never treated as a glob', () => {
    // Only `mcp__…__*` entries glob — every other entry, including one that
    // happens to end in `*`, is exact so a literal name can never accidentally
    // widen.
    const matcher = compileToolMatcher(['NotMcp*'], 'disallowedTools');
    expect(matcher.prefixes).toEqual([]);
    expect(matcher.exact.has('NotMcp*')).toBe(true);
  });
});

describe('compileToolMatcher — denyMatcher (dead-config detection)', () => {
  test('an entry already gated by denyMatcher is flagged as dead config', () => {
    const logger = fakeLogger();
    const denyMatcher = compileToolMatcher(['WebSearch'], 'disallowedTools');
    compileToolMatcher(['WebSearch'], 'askTools', logger, denyMatcher);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('also in disallowedTools'),
      { tool: 'WebSearch' },
    );
  });

  test('a server-glob deny shadows a matching entry the same way', () => {
    const logger = fakeLogger();
    const denyMatcher = compileToolMatcher(['mcp__acme__*'], 'disallowedTools');
    compileToolMatcher(['mcp__acme__push'], 'askTools', logger, denyMatcher);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('also in disallowedTools'),
      { tool: 'mcp__acme__push' },
    );
  });

  test('an entry not gated by denyMatcher compiles silently', () => {
    const logger = fakeLogger();
    const denyMatcher = compileToolMatcher(['WebSearch'], 'disallowedTools');
    compileToolMatcher(['WebFetch'], 'askTools', logger, denyMatcher);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
