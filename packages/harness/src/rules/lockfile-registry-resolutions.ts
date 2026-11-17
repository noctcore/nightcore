import type { IMetaCtx, IMetaRule, IViolation } from '../lint-meta/types.js';
import { DEFAULT_LOCKFILE, type IPackageEntry, lockfilePackageEntries } from './pnpm-lockfile.js';

export const LOCKFILE_REGISTRY_RESOLUTIONS_ID = 'lockfile-registry-resolutions';
/** The lockfile format this rule reads. Another version may write resolutions differently. */
const LOCKFILE_VERSION = '9.0';

/**
 * Every package in the pnpm lockfile resolves from the registry and carries the
 * sha512 hash pnpm checks the download against.
 *
 * pnpm's `blockExoticSubdeps` and `trustPolicy` are judged only while pnpm
 * resolves a dependency: an entry already in the lockfile is skipped, so a
 * frozen install (CI, a Docker deps stage, a git hook) never checks either
 * again. A git or tarball source that reached the lockfile on one machine would
 * install everywhere else without a word. This rule reads the lockfile itself,
 * offline, so that entry is red on every run.
 *
 * In the `packages:` section, every entry must have one
 * `resolution: {integrity: sha512-...}` line. It reports:
 *
 *   1. a resolution from a git repository (`type: git`), a tarball URL
 *      (`tarball:`, even beside an integrity hash: a tarball URL on the
 *      registry's own host passes `blockExoticSubdeps`, and a second registry
 *      for one scope writes the same shape) or a local directory (`directory:`)
 *   2. an entry with no sha512 integrity, and an entry with no resolution line
 *   3. a lockfile it cannot read: none at all, a `lockfileVersion` other than
 *      9.0, or no `packages:` section
 *
 * Workspace packages are not in `packages:` (the importers link them with
 * `link:`), so they are never reported. A direct dependency from git or a
 * tarball URL is reported too, although pnpm allows it: adopting one should be
 * a decision that changes this rule's config, not a line that slips in.
 */
export interface ILockfileRegistryResolutionsOptions {
  /** The lockfile, relative to the repo root. Default `pnpm-lock.yaml`. */
  readonly lockfile?: string;
}

const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
/** The resolution fields pnpm writes. A field outside this list, or a quoted one, is not read. */
const KNOWN_FIELDS = new Set(['integrity', 'tarball', 'type', 'directory', 'commit', 'repo']);

/**
 * The `key: value` fields of a one-line YAML flow map such as
 * `{integrity: sha512-x, tarball: y}`, or null when a field is quoted, is not
 * one pnpm writes, or the text is not one flow map.
 */
function flowFields(text: string): Map<string, string> | null {
  const inner = /^\{(.*)\}$/u.exec(text)?.[1];
  if (inner === undefined) return null;
  const fields = new Map<string, string>();
  for (const part of inner.split(',')) {
    const field = /^\s*([A-Za-z]+):\s*(.*?)\s*$/u.exec(part);
    if (field?.[1] === undefined || !KNOWN_FIELDS.has(field[1]) || fields.has(field[1])) {
      return null;
    }
    fields.set(field[1], (field[2] ?? '').replace(/^(['"])(.*)\1$/u, '$2'));
  }
  return fields;
}

/** Why one entry's resolution is not a registry download with a hash, or null when it is one. */
export function resolutionProblem(entry: IPackageEntry): string | null {
  if (entry.resolution === null) {
    return `"${entry.key}" has no resolution line, so nothing says where it was downloaded from or what hash it must match.`;
  }
  if (entry.duplicate) {
    return `"${entry.key}" has two resolution lines, so which source it installs from cannot be read.`;
  }
  const fields = entry.resolution === '' ? new Map<string, string>() : flowFields(entry.resolution);
  if (fields === null) {
    return `"${entry.key}" has a resolution this rule cannot read ("${entry.resolution}"): one line, \`{integrity: sha512-...}\`, unquoted fields pnpm writes.`;
  }
  if (fields.get('type') === 'git') {
    return `"${entry.key}" resolves from a git repository. Every package must come from the registry with an integrity hash; a frozen install never re-checks blockExoticSubdeps.`;
  }
  if (fields.has('directory') || fields.get('type') === 'directory') {
    return `"${entry.key}" resolves from a local directory. Every package must come from the registry with an integrity hash.`;
  }
  if (fields.has('tarball')) {
    return `"${entry.key}" resolves from a tarball URL ("${fields.get('tarball') ?? ''}"). Every package must come from the configured registry; a frozen install never re-checks blockExoticSubdeps.`;
  }
  if (!INTEGRITY.test(fields.get('integrity') ?? '')) {
    return `"${entry.key}" carries no sha512 integrity hash on a one-line \`resolution: {integrity: sha512-...}\`, so pnpm has nothing to check the download against (or this rule cannot read the line).`;
  }
  return null;
}

/** Every package in the pnpm lockfile resolves from the registry with a sha512 integrity hash. */
export function createLockfileRegistryResolutionsRule(
  options: ILockfileRegistryResolutionsOptions = {},
): IMetaRule {
  const lockfilePath = options.lockfile ?? DEFAULT_LOCKFILE;
  const violation = (message: string): IViolation => ({
    file: lockfilePath,
    rule: LOCKFILE_REGISTRY_RESOLUTIONS_ID,
    message,
  });

  return {
    id: LOCKFILE_REGISTRY_RESOLUTIONS_ID,
    category: 'supply-chain',
    ciCritical: true,
    description: `Every package in ${lockfilePath} resolves from the registry with a sha512 integrity hash: no git, tarball URL or directory source. A frozen install never re-checks blockExoticSubdeps or trustPolicy, so the lockfile itself is read.`,
    run(ctx: IMetaCtx): IViolation[] {
      const lockfile = ctx.read(lockfilePath);
      if (lockfile === null) {
        return [
          violation(
            `There is no ${lockfilePath}, so where each package comes from cannot be checked.`,
          ),
        ];
      }
      const version = /^lockfileVersion:\s*'?([^'\s]+)'?\s*$/mu.exec(lockfile)?.[1];
      if (version !== LOCKFILE_VERSION) {
        return [
          violation(
            `${lockfilePath} has lockfileVersion '${version ?? 'none'}'; this rule reads version ${LOCKFILE_VERSION}. Check how the new format writes a resolution, then update the rule.`,
          ),
        ];
      }
      const section = lockfilePackageEntries(lockfile);
      if (section === null) {
        return [
          violation(`${lockfilePath} has no packages: section, so no resolution can be checked.`),
        ];
      }
      return [
        ...section.unreadable.map((line) =>
          violation(
            `${lockfilePath}: this rule cannot read the line "${line}" under packages:. Every entry is a bare \`name@version:\` key two spaces in; a line it cannot read is reported, not skipped.`,
          ),
        ),
        ...section.entries.flatMap((entry) => {
          const problem = resolutionProblem(entry);
          return problem === null ? [] : [violation(problem)];
        }),
      ];
    },
  };
}
