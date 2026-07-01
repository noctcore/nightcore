/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  resolveKindPreset,
  WRITE_TOOLS,
  NETWORK_EGRESS_TOOLS,
} from './kind-presets.js';

describe('resolveKindPreset', () => {
  test('build (and the default undefined kind) denies web egress, nothing else', () => {
    // The default kind writes code but has no need to reach the live web, so the
    // egress channel is shut under bypass — everything else inherits the default.
    expect(resolveKindPreset('build')).toEqual({
      disallowedTools: [...NETWORK_EGRESS_TOOLS],
    });
    expect(resolveKindPreset(undefined)).toEqual({
      disallowedTools: [...NETWORK_EGRESS_TOOLS],
    });
  });

  test('research is the ONE web-enabled kind (explicit egress opt-in)', () => {
    // Selecting `research` is the deliberate per-task opt-in to web egress, so it
    // inherits an unrestricted toolset — WebFetch/WebSearch are NOT denied.
    expect(resolveKindPreset('research')).toEqual({});
  });

  test('review is the read-only verification reviewer with no web egress', () => {
    const preset = resolveKindPreset('review');
    expect(preset.permissionMode).toBe('dontAsk');
    expect(preset.disallowedTools).toEqual([...WRITE_TOOLS, ...NETWORK_EGRESS_TOOLS]);
    expect(preset.appendSystemPrompt).toMatch(/VERDICT: PASS/);
  });

  test('tdd adds a test-first persona and denies web egress (build-like otherwise)', () => {
    const preset = resolveKindPreset('tdd');
    // No WRITE restriction (TDD writes code) and no forced permission mode, but web
    // egress is denied exactly like the default `build` kind.
    expect(preset.disallowedTools).toEqual([...NETWORK_EGRESS_TOOLS]);
    expect(preset.permissionMode).toBeUndefined();
    expect(preset.appendSystemPrompt).toMatch(/test-driven development/i);
    expect(preset.appendSystemPrompt).toMatch(/failing test/i);
  });

  test('decompose is read-only, denies web egress, and instructs a JSON {title, prompt} array', () => {
    const preset = resolveKindPreset('decompose');
    // Read-only analysis: write tools AND web egress denied so it can only propose.
    expect(preset.disallowedTools).toEqual([...WRITE_TOOLS, ...NETWORK_EGRESS_TOOLS]);
    // The persona must instruct a JSON array of {title, prompt} objects — the engine
    // parses this via extractJson into validated `proposedSubtasks`. No sentinels.
    expect(preset.appendSystemPrompt).toMatch(/JSON array/i);
    expect(preset.appendSystemPrompt).toMatch(/"title"/);
    expect(preset.appendSystemPrompt).toMatch(/"prompt"/);
  });

  test('every non-research kind denies WebFetch and WebSearch', () => {
    for (const kind of ['build', 'tdd', 'review', 'decompose', undefined] as const) {
      const denied = resolveKindPreset(kind).disallowedTools ?? [];
      expect(denied).toContain('WebFetch');
      expect(denied).toContain('WebSearch');
    }
    // …and research does NOT (the deliberate opt-in).
    expect(resolveKindPreset('research').disallowedTools ?? []).not.toContain('WebFetch');
  });
});
