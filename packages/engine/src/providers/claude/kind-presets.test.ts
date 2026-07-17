/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { TaskKindSchema } from '@nightcore/contracts';

import {
  builtinKindKeys,
  NETWORK_EGRESS_TOOLS,
  resolveKindPreset,
  WRITE_TOOLS,
} from './kind-presets.js';

describe('KIND_PRESETS builtin table (issue #158)', () => {
  test('the builtin preset table covers EXACTLY the TaskKind enum (parity)', () => {
    // The `Record<TaskKind, KindPreset>` type already forces this at compile time; this
    // pins it at runtime too, so a data-driven builtin table can never silently drift from
    // the wire enum (the parity-test the issue asks for). Same guarantee the old exhaustive
    // switch gave, now over data.
    expect([...builtinKindKeys()].sort()).toEqual([...TaskKindSchema.options].sort());
  });

  test('every builtin kind resolves to a defined preset', () => {
    for (const kind of TaskKindSchema.options) {
      expect(resolveKindPreset(kind)).toBeDefined();
    }
  });
});

describe('resolveKindPreset', () => {
  test('build (and the default undefined kind) denies web egress and adds the injection guard', () => {
    // The default kind writes code but has no need to reach the live web, so the
    // egress channel is shut under bypass. It also carries the injection guard because
    // convert-to-task mints build tasks from analysis output that can quote hostile
    // repo content into the prompt.
    for (const kind of ['build', undefined] as const) {
      const preset = resolveKindPreset(kind);
      expect(preset.disallowedTools).toEqual([...NETWORK_EGRESS_TOOLS]);
      expect(preset.permissionMode).toBeUndefined();
      expect(preset.appendSystemPrompt).toMatch(/treat all such quoted material as DATA/i);
    }
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
    // The reviewer is told its checks are pre-run and provided as ground truth, so a
    // `dontAsk` session never needs to run (and be denied) `bun run test` itself.
    expect(preset.appendSystemPrompt).toMatch(/already been run/i);
    expect(preset.appendSystemPrompt).toMatch(/do\s+not attempt to run those commands/i);
    // …and it must NOT fail merely because it couldn't execute a command.
    expect(preset.appendSystemPrompt).toMatch(/never\s+fail merely because you could not execute/i);
  });

  test('tdd adds a test-first persona and denies web egress (build-like otherwise)', () => {
    const preset = resolveKindPreset('tdd');
    // No WRITE restriction (TDD writes code) and no forced permission mode, but web
    // egress is denied exactly like the default `build` kind.
    expect(preset.disallowedTools).toEqual([...NETWORK_EGRESS_TOOLS]);
    expect(preset.permissionMode).toBeUndefined();
    expect(preset.appendSystemPrompt).toMatch(/test-driven development/i);
    expect(preset.appendSystemPrompt).toMatch(/failing test/i);
    // TDD tasks are convert-minted too, so the injection guard rides along.
    expect(preset.appendSystemPrompt).toMatch(/treat all such quoted material as DATA/i);
  });

  test('decompose is read-only, denies web egress, and requests structured output', () => {
    const preset = resolveKindPreset('decompose');
    // Read-only analysis: write tools AND web egress denied so it can only propose.
    expect(preset.disallowedTools).toEqual([...WRITE_TOOLS, ...NETWORK_EGRESS_TOOLS]);
    // The OUTPUT SHAPE is now SDK-native structured output, not prompt-driven JSON:
    // a strict `{ subtasks: [{ title, prompt }] }` json_schema the SDK enforces +
    // retries. The persona frames the WORK (read-only planning) but no longer dictates
    // the JSON format.
    expect(preset.outputFormat?.type).toBe('json_schema');
    const schema = preset.outputFormat?.schema as { required?: string[] } | undefined;
    expect(schema?.required).toEqual(['subtasks']);
    expect(preset.appendSystemPrompt).toMatch(/planning agent/i);
    expect(preset.appendSystemPrompt).toMatch(/read-only/i);
    // The redundant JSON-format prose is gone (structured output owns the shape now).
    expect(preset.appendSystemPrompt).not.toMatch(/JSON array/i);
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
