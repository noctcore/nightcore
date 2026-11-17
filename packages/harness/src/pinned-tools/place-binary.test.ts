import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import type { IPlaceIo } from './place-binary.js';
import { nodePlaceIo, placeBinary } from './place-binary.js';

const BYTES = new Uint8Array([1, 2, 3]);

function recording(overrides: Partial<IPlaceIo> = {}): IPlaceIo & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    writeNew: (path) => void calls.push(`writeNew ${path}`),
    chmod: (path, mode) => void calls.push(`chmod ${path} ${mode.toString(8)}`),
    rename: (from, to) => void calls.push(`rename ${from} -> ${to}`),
    remove: (path) => void calls.push(`remove ${path}`),
    ...overrides,
  };
}

describe('placeBinary', () => {
  test('never writes to the final name: a new file beside it, made executable, renamed into place', () => {
    const io = recording();
    const binary = placeBinary(BYTES, 'tool', join('bin', 'tools'), 'tok', io);
    const staged = join('bin', 'tools', '.tool.tok.partial');
    expect(binary).toBe(join('bin', 'tools', 'tool'));
    expect(io.calls).toEqual([
      `writeNew ${staged}`,
      `chmod ${staged} 755`,
      `rename ${staged} -> ${binary}`,
    ]);
  });

  test('removes the staged file and fails when it cannot be put in place', () => {
    const io = recording({
      rename: () => {
        throw new Error('EXDEV');
      },
    });
    expect(() => placeBinary(BYTES, 'tool', 'bin', 'tok', io)).toThrow(/EXDEV/u);
    expect(io.calls.at(-1)).toBe(`remove ${join('bin', '.tool.tok.partial')}`);
  });

  test('on a real directory: replaces what was there, and refuses a staging name that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'place-binary-'));
    try {
      writeFileSync(join(dir, 'tool'), 'an older binary');
      const binary = placeBinary(BYTES, 'tool', dir, 'tok', nodePlaceIo);
      expect([...readFileSync(binary)]).toEqual([1, 2, 3]);

      writeFileSync(join(dir, '.tool.tok.partial'), 'left by someone else');
      expect(() => placeBinary(BYTES, 'tool', dir, 'tok', nodePlaceIo)).toThrow(/EEXIST/u);
      expect(readFileSync(join(dir, '.tool.tok.partial'), 'utf8')).toBe('left by someone else');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
