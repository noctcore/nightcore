/**
 * A reader for the `packages:` section of a pnpm v9 lockfile, shared by the
 * rules that read where each package resolves from and how many versions of it
 * are installed.
 */

/** The default lockfile path, relative to the repo root. */
export const DEFAULT_LOCKFILE = 'pnpm-lock.yaml';

export interface IPackageEntry {
  readonly key: string;
  /** The text after `resolution:` on the entry's resolution line, or null when it has none. */
  readonly resolution: string | null;
  /** Whether the entry holds more than one resolution line. */
  readonly duplicate: boolean;
}

export interface IPackagesSection {
  readonly entries: readonly IPackageEntry[];
  /** Lines at an entry's indent that are not a bare `name@version:` key, or at an indent no entry uses. */
  readonly unreadable: readonly string[];
}

/**
 * A `name@version:` key alone on its line, bare or single-quoted. Anything
 * after the colon (a trailing ` # comment` included) makes it unreadable; a
 * `#` inside a bare key, as in a git source's `repo.git#sha`, is not a comment.
 */
const ENTRY_KEY = /^ {2}(?:'([^']+)'|([^\s'"]+)):$/u;

/** The entries of the top-level `packages:` section, or null when there is no such section. */
export function lockfilePackageEntries(lockfile: string): IPackagesSection | null {
  const lines = lockfile.split('\n');
  const start = lines.indexOf('packages:');
  if (start === -1) return null;

  const entries: { key: string; resolution: string | null; duplicate: boolean }[] = [];
  const unreadable: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    if (line.trim() === '') continue;
    if (/^ {2}\S/u.test(line)) {
      const key = ENTRY_KEY.exec(line);
      const name = key?.[1] ?? key?.[2];
      if (name === undefined) {
        unreadable.push(line.trim());
      } else {
        entries.push({ key: name, resolution: null, duplicate: false });
      }
      continue;
    }
    if (!/^ {4}/u.test(line)) {
      unreadable.push(line.trim());
      continue;
    }
    const resolution = /^ {4}resolution:(.*)$/u.exec(line);
    const current = entries.at(-1);
    if (resolution !== null && current !== undefined) {
      if (current.resolution !== null) current.duplicate = true;
      current.resolution = (resolution[1] ?? '').trim();
    }
  }
  return { entries, unreadable };
}

/** `@scope/name@1.2.3(peer@1)` to its name and version (peer suffix kept on the version). */
export function splitPackageKey(key: string): { name: string; version: string } {
  const at = key.indexOf('@', 1);
  if (at === -1) return { name: key, version: '' };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}
