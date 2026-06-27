/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { resolveKindPreset, WRITE_TOOLS } from './kind-presets.js';

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

  test('decompose is read-only and instructs a JSON {title, prompt} array', () => {
    const preset = resolveKindPreset('decompose');
    // Read-only analysis: write tools denied so it can only propose.
    expect(preset.disallowedTools).toEqual([...WRITE_TOOLS]);
    // The persona must instruct a JSON array of {title, prompt} objects — the engine
    // parses this via extractJson into validated `proposedSubtasks`. No sentinels.
    expect(preset.appendSystemPrompt).toMatch(/JSON array/i);
    expect(preset.appendSystemPrompt).toMatch(/"title"/);
    expect(preset.appendSystemPrompt).toMatch(/"prompt"/);
  });
});
