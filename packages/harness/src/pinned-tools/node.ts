/*
 * The node-backed dependencies the pure functions in this module take, so a
 * repo's CLI is a few lines: pick the pin, hand over these deps, print the
 * verdict and exit with `exitCodeFor`. Every spawn passes an argv, never a
 * shell string.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { IFetchDeps } from './fetch.js';
import type { IGitleaksRunDeps } from './gitleaks.js';
import { placeBinary } from './place-binary.js';
import type { IRunDeps } from './route.js';
import { parseVersion } from './route.js';

/** Whether a Docker daemon answers. */
export function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
  });
  return result.error === undefined && result.status === 0;
}

/** The repo-relative `.github/workflows/*.y(a)ml` files under `root`, sorted, with `/` separators. */
export function workflowFilesUnder(root: string): readonly string[] {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`);
}

function spawnShown(command: string, args: readonly string[], cwd: string): number | null {
  const result = spawnSync(command, [...args], { cwd, stdio: 'inherit' });
  return result.error === undefined ? result.status : null;
}

function reportedVersion(command: string, args: readonly string[]): string | null {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return null;
  return parseVersion(`${result.stdout}\n${result.stderr}`);
}

/** `runLinter`'s deps on this machine: PATH, the Docker CLI, and the repo's workflow files. */
export function nodeRunDeps(): IRunDeps {
  return {
    workflows: workflowFilesUnder,
    nativeVersion: (tool) => reportedVersion(tool.name, tool.versionArgs),
    dockerAvailable,
    imagePresent: (image) => {
      const result = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
      return result.error === undefined && result.status === 0;
    },
    pull: (image) => {
      const result = spawnSync('docker', ['pull', '--quiet', image], { stdio: 'inherit' });
      return result.error === undefined && result.status === 0;
    },
    spawn: spawnShown,
  };
}

/** `runGitleaks`'s deps for the checkout at `root`. */
export function nodeGitleaksDeps(root: string): IGitleaksRunDeps {
  return {
    nativeVersion: () => reportedVersion('gitleaks', ['version']),
    dockerAvailable,
    gitDirIsLocal: () => {
      try {
        return statSync(join(root, '.git')).isDirectory();
      } catch {
        return false;
      }
    },
    spawn: spawnShown,
  };
}

export interface INodeFetchOptions {
  /**
   * Download a release path under https://github.com/. The caller supplies it:
   * this package makes no network calls of its own, so the one that fetches
   * stays in the consuming repo, where its origin and timeout are reviewed.
   */
  readonly download: (path: string) => Promise<Uint8Array>;
  /** Keeps the staging names of two concurrent runs apart. Defaults to the process id. */
  readonly token?: string;
}

/**
 * `fetchPinned`'s deps on a linux machine around the caller's `download`:
 * sha256 from node:crypto, `tar -xzf` for archives, and `placeBinary` for an
 * asset that is the binary itself.
 */
export function nodeFetchDeps(options: INodeFetchOptions): IFetchDeps {
  const token = options.token ?? String(process.pid);
  return {
    download: options.download,
    sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
    unpack(bytes, member, dir) {
      const work = mkdtempSync(join(tmpdir(), 'pinned-tool-'));
      try {
        const archive = join(work, 'archive.tar.gz');
        writeFileSync(archive, bytes);
        const tar = spawnSync('tar', ['-xzf', archive, '-C', work, member], { encoding: 'utf8' });
        if (tar.error !== undefined || tar.status !== 0) {
          throw new Error(`tar could not unpack ${member}: ${tar.stderr}`);
        }
        const binary = join(dir, basename(member));
        renameSync(join(work, member), binary);
        chmodSync(binary, 0o755);
        return binary;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    place: (bytes, name, dir) => placeBinary(bytes, name, dir, token),
    versionOf: (binary, tool) => reportedVersion(binary, tool.versionArgs),
  };
}
