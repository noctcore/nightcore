/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  DECOMPOSE_OUTPUT_FORMAT,
  parseSubtasks,
  subtasksFromStructuredOutput,
} from './decompose.js';

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

describe('subtasksFromStructuredOutput', () => {
  test('validates the SDK `{ subtasks }` object into proposals', () => {
    const structured = {
      subtasks: [
        { title: 'A', prompt: 'do a' },
        { title: 'B', prompt: 'do b' },
      ],
    };
    expect(subtasksFromStructuredOutput(structured)).toEqual([
      { title: 'A', prompt: 'do a' },
      { title: 'B', prompt: 'do b' },
    ]);
  });

  test('present-but-empty structured output yields [] (NOT undefined — no text fallback)', () => {
    // A legitimately empty decomposition: structured output IS present, so the
    // caller must trust the empty list rather than fall back to parsing prose.
    expect(subtasksFromStructuredOutput({ subtasks: [] })).toEqual([]);
  });

  test('drops blank-title / schema-failing items, same as the text path', () => {
    const structured = {
      subtasks: [
        { title: '  ', prompt: 'blank title dropped' },
        { title: 'Keep', prompt: 'kept' },
        { title: 'no prompt' },
      ],
    };
    expect(subtasksFromStructuredOutput(structured)).toEqual([
      { title: 'Keep', prompt: 'kept' },
    ]);
  });

  test('returns undefined when structured output is absent (→ caller falls back to text)', () => {
    expect(subtasksFromStructuredOutput(undefined)).toBeUndefined();
    expect(subtasksFromStructuredOutput(null)).toBeUndefined();
  });

  test('tolerates a bare array (no `subtasks` wrapper)', () => {
    expect(subtasksFromStructuredOutput([{ title: 'A', prompt: 'do a' }])).toEqual([
      { title: 'A', prompt: 'do a' },
    ]);
  });
});

describe('DECOMPOSE_OUTPUT_FORMAT', () => {
  test('is a json_schema requiring a strict { subtasks: [{ title, prompt }] } object', () => {
    expect(DECOMPOSE_OUTPUT_FORMAT.type).toBe('json_schema');
    const schema = DECOMPOSE_OUTPUT_FORMAT.schema as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: {
        subtasks: {
          type: string;
          items: {
            required: string[];
            additionalProperties: boolean;
            properties: Record<string, { type: string }>;
          };
        };
      };
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['subtasks']);
    // Structured-output schemas require additionalProperties:false at every level.
    expect(schema.additionalProperties).toBe(false);
    const item = schema.properties.subtasks.items;
    expect(schema.properties.subtasks.type).toBe('array');
    expect(item.required).toEqual(['title', 'prompt']);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.title.type).toBe('string');
    expect(item.properties.prompt.type).toBe('string');
  });
});
