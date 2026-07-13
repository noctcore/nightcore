/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  composeAppendSystemPrompt,
  CONTEXT_PACK_MAX_CHARS,
  workingRootDirective,
} from './system-prompt.js';

describe('workingRootDirective', () => {
  test('names the cwd and states writes outside it are blocked', () => {
    const directive = workingRootDirective('/repo/.nightcore/worktrees/task-1');
    expect(directive.startsWith('# Working directory (authoritative)')).toBe(true);
    expect(directive).toContain('/repo/.nightcore/worktrees/task-1');
    expect(directive).toContain('Writes outside this directory are blocked');
  });
});

describe('composeAppendSystemPrompt — Pre-flight Context Pack (Lock, feature #4)', () => {
  const persona = 'You are an independent code reviewer.';
  const pack = 'PROJECT CONSTITUTION: never break the folder-per-component rule.';

  const root = '# Working directory (authoritative)\n\n  /repo/wt';

  test('orders the working root BEFORE the pack, and the pack BEFORE the persona', () => {
    const composed = composeAppendSystemPrompt(root, pack, persona);
    expect(composed).toBeDefined();
    expect(composed!.indexOf(root)).toBe(0);
    expect(composed!.indexOf(root)).toBeLessThan(composed!.indexOf(pack));
    expect(composed!.indexOf(pack)).toBeLessThan(composed!.indexOf(persona));
  });

  test('orders the context pack BEFORE the kind-preset persona (no working root)', () => {
    const composed = composeAppendSystemPrompt(undefined, pack, persona);
    expect(composed).toBeDefined();
    const packAt = composed!.indexOf(pack);
    const personaAt = composed!.indexOf(persona);
    expect(packAt).toBe(0);
    expect(packAt).toBeLessThan(personaAt);
  });

  test('returns just the pack when there is no working root or persona', () => {
    expect(composeAppendSystemPrompt(undefined, pack, undefined)).toBe(pack);
  });

  test('returns just the persona when there is no working root or pack', () => {
    expect(composeAppendSystemPrompt(undefined, undefined, persona)).toBe(persona);
    expect(composeAppendSystemPrompt(undefined, '   ', persona)).toBe(persona);
  });

  test('returns undefined when every part is absent (omits the SDK option)', () => {
    expect(composeAppendSystemPrompt(undefined, undefined, undefined)).toBeUndefined();
    expect(composeAppendSystemPrompt('', '', '')).toBeUndefined();
  });

  test('truncates an oversized pack to the budget with a notice', () => {
    const huge = 'x'.repeat(CONTEXT_PACK_MAX_CHARS + 5000);
    const composed = composeAppendSystemPrompt(undefined, huge, persona);
    expect(composed).toBeDefined();
    // The bounded pack is at most the budget plus the short truncation notice, and
    // is far shorter than the raw input — it cannot crowd out the task.
    expect(composed!.length).toBeLessThan(huge.length);
    expect(composed).toContain('truncated');
    // The persona still survives at the end (the pack didn't swallow it).
    expect(composed!.endsWith(persona)).toBe(true);
  });
});
