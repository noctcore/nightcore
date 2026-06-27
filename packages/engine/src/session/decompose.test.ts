/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { parseSubtasks } from './decompose.js';

describe('parseSubtasks', () => {
  test('parses a ```json fenced block', () => {
    const raw = [
      'Here is my plan:',
      '```json',
      '[{"title": "Add schema", "prompt": "Define the zod schema"}]',
      '```',
    ].join('\n');
    expect(parseSubtasks(raw)).toEqual([
      { title: 'Add schema', prompt: 'Define the zod schema' },
    ]);
  });

  test('parses a bare JSON array', () => {
    const raw =
      '[{"title":"A","prompt":"do a"},{"title":"B","prompt":"do b"}]';
    expect(parseSubtasks(raw)).toEqual([
      { title: 'A', prompt: 'do a' },
      { title: 'B', prompt: 'do b' },
    ]);
  });

  test('extracts a JSON array embedded in a prose markdown plan', () => {
    // The realistic decompose case: a written plan followed by the JSON array.
    const raw = [
      '# Decomposition plan',
      '',
      'I propose breaking this into two steps:',
      '',
      '1. First wire the contract.',
      '2. Then build the UI.',
      '',
      'Proposed sub-tasks:',
      '[{"title": "Wire contract", "prompt": "Add the field to the schema"},',
      ' {"title": "Build UI", "prompt": "Render the new field"}]',
    ].join('\n');
    expect(parseSubtasks(raw)).toEqual([
      { title: 'Wire contract', prompt: 'Add the field to the schema' },
      { title: 'Build UI', prompt: 'Render the new field' },
    ]);
  });

  test('returns an empty array for empty, prose-only, or malformed input', () => {
    expect(parseSubtasks('')).toEqual([]);
    expect(parseSubtasks('no json here, just a paragraph of analysis')).toEqual(
      [],
    );
    expect(parseSubtasks('```json\n{ not valid json,, }\n```')).toEqual([]);
  });

  test('drops items with a blank/whitespace title or that fail the schema', () => {
    const raw = JSON.stringify([
      { title: '   ', prompt: 'has a blank title' }, // dropped: blank title
      { title: 'Keep me', prompt: 'valid' }, // kept
      { title: 'Missing prompt' }, // dropped: prompt is required by the schema
    ]);
    expect(parseSubtasks(raw)).toEqual([{ title: 'Keep me', prompt: 'valid' }]);
  });
});
