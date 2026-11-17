import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

import { nodeFetchDeps, nodeGitleaksDeps, nodeRunDeps, workflowFilesUnder } from './node.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pinned-tools-node-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('workflowFilesUnder', () => {
  test('lists the yml and yaml workflows, sorted, repo-relative with / separators', () => {
    const root = tempDir();
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    for (const name of ['b.yaml', 'a.yml', 'notes.md']) {
      writeFileSync(join(root, '.github', 'workflows', name), '');
    }
    expect(workflowFilesUnder(root)).toEqual(['.github/workflows/a.yml', '.github/workflows/b.yaml']);
  });

  test('is empty when there is no workflow directory', () => {
    expect(workflowFilesUnder(tempDir())).toEqual([]);
  });
});

describe('nodeGitleaksDeps', () => {
  test('sees a .git directory as local history, and a worktree pointer file as not', () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    expect(nodeGitleaksDeps(repo).gitDirIsLocal()).toBe(true);
    const worktree = tempDir();
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n');
    expect(nodeGitleaksDeps(worktree).gitDirIsLocal()).toBe(false);
    expect(nodeGitleaksDeps(tempDir()).gitDirIsLocal()).toBe(false);
  });
});

describe('nodeRunDeps', () => {
  test('reports no native version for a tool that is not on PATH', () => {
    const missing = { name: 'no-such-pinned-tool-x', version: '1.0.0', versionArgs: ['--version'] };
    expect(nodeRunDeps().nativeVersion({ ...missing, linux: {} as never })).toBeNull();
  });

  test('reports a spawn that could not start as null', () => {
    expect(nodeRunDeps().spawn('no-such-pinned-tool-x', [], tempDir())).toBeNull();
  });
});

describe('nodeFetchDeps', () => {
  const noDownload = (): Promise<Uint8Array> => Promise.reject(new Error('no network in tests'));

  test("hands back the caller's download untouched", () => {
    expect(nodeFetchDeps({ download: noDownload }).download).toBe(noDownload);
  });

  test('hashes with sha256', () => {
    expect(nodeFetchDeps({ download: noDownload }).sha256(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('places a bare binary executable under its name', () => {
    const dir = tempDir();
    const binary = nodeFetchDeps({ download: noDownload, token: 't' }).place(new Uint8Array([1]), 'tool', dir);
    expect(binary).toBe(join(dir, 'tool'));
  });

  test('refuses an archive member tar cannot find, and leaves nothing behind', () => {
    const dir = tempDir();
    expect(() => nodeFetchDeps({ download: noDownload }).unpack(new Uint8Array([1, 2, 3]), 'missing/tool', dir)).toThrow(
      /tar could not unpack missing\/tool/u,
    );
  });
});
