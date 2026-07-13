/**
 * Degrade-not-throw filesystem primitives shared by the Harness repo-profiler
 * (`repo-profile.ts`, `workspace-resolution.ts`). Every read is wrapped in
 * try/catch and NEVER throws: a missing or garbage path collapses to a
 * conservative default (`undefined`/`false`/`[]`) so a malformed repo still
 * yields a usable profile rather than a crash.
 */
import * as fs from 'node:fs';

export function readText(absPath: string): string | undefined {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return undefined;
  }
}

export function readJson(absPath: string): Record<string, unknown> | undefined {
  const text = readText(absPath);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

export function fileExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

export function dirExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** Immediate subdirectory names of `absPath` (empty when unreadable). */
export function listDirs(absPath: string): string[] {
  try {
    return fs
      .readdirSync(absPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Immediate file names of `absPath` (empty when unreadable). */
export function listFiles(absPath: string): string[] {
  try {
    return fs
      .readdirSync(absPath, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Normalize an OS path to forward slashes (so generated/contract paths match). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
