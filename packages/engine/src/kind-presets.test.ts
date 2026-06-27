/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  resolveKindPreset,
  SUBTASKS_CLOSE,
  SUBTASKS_OPEN,
  WRITE_TOOLS,
} from './kind-presets.js';

describe('resolveKindPreset', () => {
  test('build and research inherit every session default (no overrides)', () => {
    expect(resolveKindPreset('build')).toEqual({});
    expect(resolveKindPreset('research')).toEqual({});
    expect(resolveKindPreset(undefined)).toEqual({});
  });

  test('review is the read-only verification reviewer', () => {
    const preset = resolveKindPreset('review');
    expect(preset.permissionMode).toBe('dontAsk');
    expect(preset.disallowedTools).toEqual([...WRITE_TOOLS]);
    expect(preset.appendSystemPrompt).toMatch(/VERDICT: PASS/);
  });

  test('tdd adds a test-first persona but is otherwise build-like', () => {
    const preset = resolveKindPreset('tdd');
    // No tool restriction (TDD writes code) and no forced permission mode.
    expect(preset.disallowedTools).toBeUndefined();
    expect(preset.permissionMode).toBeUndefined();
    expect(preset.appendSystemPrompt).toMatch(/test-driven development/i);
    expect(preset.appendSystemPrompt).toMatch(/failing test/i);
  });

  test('decompose is read-only and instructs the sub-task sentinel block', () => {
    const preset = resolveKindPreset('decompose');
    // Read-only analysis: write tools denied so it can only propose.
    expect(preset.disallowedTools).toEqual([...WRITE_TOOLS]);
    // The persona must name the exact sentinels the Rust core parses.
    expect(preset.appendSystemPrompt).toContain(SUBTASKS_OPEN);
    expect(preset.appendSystemPrompt).toContain(SUBTASKS_CLOSE);
    expect(preset.appendSystemPrompt).toMatch(/"title"/);
    expect(preset.appendSystemPrompt).toMatch(/"prompt"/);
  });
});
