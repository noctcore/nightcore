/// <reference types="bun" />
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  asRecord,
  dirExists,
  fileExists,
  listDirs,
  listFiles,
  readJson,
  readText,
  toPosix,
} from './fs-probe.js';

/**
 * Drive the degrade-not-throw fs primitives against real tmp-dir fixtures —
 * every primitive must collapse a missing/garbage path to a conservative
 * default rather than throw.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fs-probe-'));
  dirs.push(dir);
  return dir;
}

describe('readText', () => {
  test('returns file contents when the file exists', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
    expect(readText(path.join(dir, 'a.txt'))).toBe('hello');
  });

  test('returns undefined for a missing file', () => {
    expect(readText('/no/such/path/nc-fs-probe-test.txt')).toBeUndefined();
  });
});

describe('readJson', () => {
  test('returns a parsed record for valid JSON object text', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.json'), '{"name":"x"}');
    expect(readJson(path.join(dir, 'a.json'))).toEqual({ name: 'x' });
  });

  test('returns undefined for invalid JSON', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.json'), '{ not json');
    expect(readJson(path.join(dir, 'a.json'))).toBeUndefined();
  });

  test('returns undefined for JSON whose top level is a primitive (e.g. a number)', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.json'), '42');
    expect(readJson(path.join(dir, 'a.json'))).toBeUndefined();
  });

  test('returns undefined for a missing file', () => {
    expect(readJson('/no/such/path/nc-fs-probe-test.json')).toBeUndefined();
  });
});

describe('fileExists', () => {
  test('true for a regular file', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), '');
    expect(fileExists(path.join(dir, 'a.txt'))).toBe(true);
  });

  test('false for a directory', () => {
    const dir = makeTmpDir();
    expect(fileExists(dir)).toBe(false);
  });

  test('false for a missing path', () => {
    expect(fileExists(path.join(makeTmpDir(), 'nope.txt'))).toBe(false);
  });
});

describe('dirExists', () => {
  test('true for a directory', () => {
    const dir = makeTmpDir();
    expect(dirExists(dir)).toBe(true);
  });

  test('false for a regular file', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), '');
    expect(dirExists(path.join(dir, 'a.txt'))).toBe(false);
  });

  test('false for a missing path', () => {
    expect(dirExists(path.join(makeTmpDir(), 'nope'))).toBe(false);
  });
});

describe('listDirs', () => {
  test('lists only immediate subdirectory names', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'sub-a'));
    fs.mkdirSync(path.join(dir, 'sub-b'));
    fs.writeFileSync(path.join(dir, 'file.txt'), '');
    expect(listDirs(dir).sort()).toEqual(['sub-a', 'sub-b']);
  });

  test('empty array for a missing directory', () => {
    expect(listDirs(path.join(makeTmpDir(), 'nope'))).toEqual([]);
  });
});

describe('listFiles', () => {
  test('lists only immediate file names', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.txt'), '');
    fs.writeFileSync(path.join(dir, 'b.txt'), '');
    expect(listFiles(dir).sort()).toEqual(['a.txt', 'b.txt']);
  });

  test('empty array for a missing directory', () => {
    expect(listFiles(path.join(makeTmpDir(), 'nope'))).toEqual([]);
  });
});

describe('asRecord', () => {
  test('passes through a plain object', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  test('an array also passes through (typeof array is "object")', () => {
    expect(asRecord([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test('undefined for null', () => {
    expect(asRecord(null)).toBeUndefined();
  });

  test('undefined for a primitive', () => {
    expect(asRecord('x')).toBeUndefined();
    expect(asRecord(42)).toBeUndefined();
  });
});

describe('toPosix', () => {
  test('converts backslashes to forward slashes', () => {
    expect(toPosix('apps\\web\\src')).toBe('apps/web/src');
  });

  test('leaves an already-posix path unchanged', () => {
    expect(toPosix('apps/web/src')).toBe('apps/web/src');
  });
});
