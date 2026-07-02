/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { ToolRegistry } from './tool-registry.js';

describe('ToolRegistry native-tool risk classification', () => {
  const registry = new ToolRegistry();

  test('native read-only tools are classified safe so they auto-allow', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite']) {
      expect(registry.riskOf(tool)).toBe('safe');
    }
  });

  test('native write/edit tools are classified mutating', () => {
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      expect(registry.riskOf(tool)).toBe('mutating');
    }
  });

  test('shell and network tools are classified dangerous (always prompt)', () => {
    for (const tool of ['Bash', 'WebFetch', 'WebSearch']) {
      expect(registry.riskOf(tool)).toBe('dangerous');
    }
  });

  test('unknown and external mcp tools resolve to undefined (→ most-cautious)', () => {
    // undefined folds into `dangerous` at the PermissionLayer, so an unrecognised
    // or external tool still prompts outside bypass.
    expect(registry.riskOf('mcp__external__mystery')).toBeUndefined();
    expect(registry.riskOf('SomeUnknownTool')).toBeUndefined();
  });
});
