/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from './tool-registry.js';

describe('ToolRegistry native-tool risk classification (M4.7 §A3)', () => {
  const registry = new ToolRegistry();

  test('native read-only tools are classified safe so they auto-allow', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'LS']) {
      expect(registry.riskOf(tool)).toBe('safe');
    }
  });

  test('native write/edit/shell tools stay unknown (→ prompt-worthy)', () => {
    // Deliberately NOT classified safe: undefined folds into `dangerous` at the
    // PermissionLayer, so they still prompt outside bypass.
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit']) {
      expect(registry.riskOf(tool)).toBeUndefined();
    }
  });

  test('the custom MCP descriptor risks still resolve (kept for metadata)', () => {
    expect(registry.riskOf('mcp__nightcore__read_file')).toBe('safe');
    expect(registry.riskOf('mcp__nightcore__run_command')).toBe('dangerous');
  });
});
