import { describe, expect, test } from 'bun:test';

import { createFakeCtx } from '../lint-meta/create-fake-ctx.js';
import { workflowFiles } from './workflow-files.js';
import { blockUnder, indentOf, stripYamlComment, unquote } from './yaml-lines.js';

describe('the YAML line helpers', () => {
  test('strip a comment at the start or after whitespace, but not a # inside a value', () => {
    expect(stripYamlComment('key: value # note')).toBe('key: value');
    expect(stripYamlComment('# whole line')).toBe('');
    expect(stripYamlComment('url: repo.git#sha')).toBe('url: repo.git#sha');
  });

  test('unquote either kind of quote and leave a bare scalar alone', () => {
    expect(unquote(" 'a' ")).toBe('a');
    expect(unquote('"b"')).toBe('b');
    expect(unquote('c')).toBe('c');
    expect(unquote('\'mixed"')).toBe('\'mixed"');
  });

  test('measure indent and find the block under a key, blank lines inside it included', () => {
    const lines = ['jobs:', '  a:', '', '    x: 1', 'next:'];
    expect(indentOf(lines[3] ?? '')).toBe(4);
    expect(blockUnder(lines, 0)).toEqual({ start: 1, end: 4 });
    expect(blockUnder(lines, 4)).toEqual({ start: 5, end: 5 });
  });

  test('list the workflows of both extensions, sorted and once each', () => {
    const ctx = createFakeCtx({
      files: {
        '.github/workflows/b.yml': 'x',
        '.github/workflows/a.yaml': 'x',
        '.github/other/c.yml': 'x',
      },
    });
    expect(workflowFiles(ctx)).toEqual(['.github/workflows/a.yaml', '.github/workflows/b.yml']);
  });
});
