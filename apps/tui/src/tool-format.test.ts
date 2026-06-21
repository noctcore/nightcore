/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { editPreview, summarizeTool } from './tool-format.js';

describe('summarizeTool', () => {
  test('Edit shortens a deep file path', () => {
    const s = summarizeTool('Edit', {
      file_path: '/Users/me/Documents/Projects/nightcore/apps/tui/src/App.tsx',
    });
    expect(s.label).toBe('Edit');
    expect(s.glyph).toBe('✎');
    expect(s.target).toBe('…/tui/src/App.tsx');
  });

  test('Bash surfaces the command as target and description as detail', () => {
    const s = summarizeTool('Bash', {
      command: 'pwd && ls -la',
      description: 'Show current directory',
    });
    expect(s.label).toBe('Bash');
    expect(s.target).toBe('pwd && ls -la');
    expect(s.detail).toBe('Show current directory');
  });

  test('Read appends an offset/limit range', () => {
    const s = summarizeTool('Read', {
      file_path: 'src/x.ts',
      offset: 10,
      limit: 50,
    });
    expect(s.target).toBe('src/x.ts:10+50');
  });

  test('strips the MCP namespace prefix and maps snake_case tools', () => {
    const s = summarizeTool('mcp__nightcore__run_command', {
      command: 'bun test',
    });
    expect(s.label).toBe('Bash');
    expect(s.target).toBe('bun test');
  });

  test('unknown tool falls back to compact JSON', () => {
    const s = summarizeTool('Mystery', { a: 1, b: 'two' });
    expect(s.label).toBe('Mystery');
    expect(s.target).toBe('{"a":1,"b":"two"}');
  });
});

describe('editPreview', () => {
  test('returns null when there is no old/new pair', () => {
    expect(editPreview({ file_path: 'x', content: 'hi' })).toBeNull();
  });

  test('splits old and new strings into line arrays', () => {
    const p = editPreview({ old_string: 'a\nb', new_string: 'a\nB\nc' });
    expect(p).not.toBeNull();
    expect(p?.removed).toEqual(['a', 'b']);
    expect(p?.added).toEqual(['a', 'B', 'c']);
    expect(p?.truncated).toBe(0);
  });

  test('a pure insertion has no removed lines', () => {
    const p = editPreview({ old_string: '', new_string: 'new line' });
    expect(p?.removed).toEqual([]);
    expect(p?.added).toEqual(['new line']);
  });

  test('caps the preview and reports how many lines were elided', () => {
    const old = Array.from({ length: 8 }, (_, i) => `o${String(i)}`).join('\n');
    const next = Array.from({ length: 8 }, (_, i) => `n${String(i)}`).join('\n');
    const p = editPreview({ old_string: old, new_string: next });
    expect(p).not.toBeNull();
    const shown = (p?.removed.length ?? 0) + (p?.added.length ?? 0);
    expect(shown).toBe(10);
    expect(p?.truncated).toBe(6);
  });
});
