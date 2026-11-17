import type { IMetaCtx, IMetaRule, IViolation } from '../lint-meta/types.js';
import { DEFAULT_LOCKFILE, lockfilePackageEntries, splitPackageKey } from './pnpm-lockfile.js';

export const SINGLE_VERSION_DEPENDENCIES_ID = 'single-version-dependencies';

/**
 * The packages that must resolve to exactly one version in the pnpm lockfile.
 *
 * Two copies of some packages is a defect, not drift: two compilers type-check
 * a repo differently, two ORM clients disagree with their engine, two Reacts
 * break hooks at runtime, two ESLints load plugins against the wrong core. The
 * repo names those packages; the list carries no exception, so add a package
 * only once it resolves once.
 *
 * Reported: a listed package with more than one version in the `packages:`
 * section (one version under several peer sets is one version), a listed
 * package the lockfile does not hold at all (a stale entry passes nothing),
 * and a lockfile with no `packages:` section.
 */
export interface ISingleVersionDependenciesOptions {
  /** The package names that must resolve once. At least one. */
  readonly packages: readonly string[];
  /** The lockfile, relative to the repo root. Default `pnpm-lock.yaml`. */
  readonly lockfile?: string;
}

/** The listed packages each resolve to exactly one version in the pnpm lockfile. */
export function createSingleVersionDependenciesRule(
  options: ISingleVersionDependenciesOptions,
): IMetaRule {
  const packages = [...options.packages];
  if (packages.length === 0) {
    throw new Error(
      `${SINGLE_VERSION_DEPENDENCIES_ID} needs at least one package: an empty list checks nothing.`,
    );
  }
  const lockfilePath = options.lockfile ?? DEFAULT_LOCKFILE;
  const violation = (message: string): IViolation => ({
    file: lockfilePath,
    rule: SINGLE_VERSION_DEPENDENCIES_ID,
    message,
  });

  return {
    id: SINGLE_VERSION_DEPENDENCIES_ID,
    category: 'supply-chain',
    ciCritical: true,
    description: `${packages.join(', ')} each resolve to exactly one version in ${lockfilePath}, with no exception list.`,
    run(ctx: IMetaCtx): IViolation[] {
      const lockfile = ctx.read(lockfilePath);
      const entries = lockfile === null ? null : lockfilePackageEntries(lockfile)?.entries;
      if (entries === undefined || entries === null) {
        return [
          violation(
            `${lockfilePath} is missing or has no packages: section, so no version can be counted.`,
          ),
        ];
      }
      const versions = new Map<string, Set<string>>();
      for (const { key } of entries) {
        const { name, version } = splitPackageKey(key);
        const found = versions.get(name) ?? new Set<string>();
        found.add(version.replace(/\(.*$/u, ''));
        versions.set(name, found);
      }
      return packages.flatMap((name) => {
        const found = [...(versions.get(name) ?? [])].sort();
        if (found.length === 0) {
          return [
            violation(
              `"${name}" is not in ${lockfilePath}. Remove it from the rule's packages only if the repo no longer depends on it.`,
            ),
          ];
        }
        if (found.length > 1) {
          return [
            violation(
              `"${name}" resolves to ${String(found.length)} versions in ${lockfilePath} (${found.join(', ')}). Align every range that reaches it (a devDependency pin for an auto-installed peer, the same range in every manifest) so one version remains.`,
            ),
          ];
        }
        return [];
      });
    },
  };
}
