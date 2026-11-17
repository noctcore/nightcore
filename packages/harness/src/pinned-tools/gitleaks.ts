/*
 * A full-history gitleaks scan, found the way CI's version allows:
 *   1. a native gitleaks that reports exactly CI's version;
 *   2. else the gitleaks image pinned by digest (it must carry that same
 *      version), when Docker answers and the checkout's `.git` is a directory
 *      the container can read (a worktree's `.git` is a file naming a directory
 *      outside the mount, so there the image could not see the history);
 *   3. else BLOCKED, exit 2: a scan that did not run is never a pass.
 * The version comes from the caller, normally read from the workflow CI
 * installs it in (`pinnedGitleaksVersion`), so a local scan never runs another
 * ruleset than CI does.
 */
import { GITLEAKS_IMAGE } from './pins.js';
import type { LinterRoute, LinterStatus } from './route.js';
import { linterVerdict } from './route.js';

/** The env variable a workflow pins gitleaks with, unless the caller names another. */
export const GITLEAKS_VERSION_VARIABLE = 'GITLEAKS_VERSION';

/** A workflow's `<variable>: 'x.y.z'` line, or null when it names none. */
export function pinnedGitleaksVersion(
  workflow: string,
  variable: string = GITLEAKS_VERSION_VARIABLE,
): string | null {
  if (!/^\w+$/u.test(variable)) {
    throw new Error(`pinnedGitleaksVersion: "${variable}" is not a plain variable name`);
  }
  const line = new RegExp(`^\\s*${variable}:\\s*['"]?(\\d+\\.\\d+\\.\\d+)['"]?\\s*$`, 'mu');
  return line.exec(workflow)?.[1] ?? null;
}

/** The version a digest-pinned gitleaks image names in its tag, or null when it is not one. */
export function imageVersion(image: string): string | null {
  return /:v(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/u.exec(image)?.[1] ?? null;
}

/** The repo config a scan reads, unless the caller names another. */
export const GITLEAKS_CONFIG = '.gitleaks.toml';

/** The scan CI runs, reading history from the checkout at the working directory. */
export function gitleaksArgs(config: string = GITLEAKS_CONFIG): readonly string[] {
  return ['git', '.', '--config', config, '--no-banner', '--redact', '--exit-code', '1'];
}

export type GitleaksRoute = LinterRoute;

export interface IGitleaksDeps {
  /** The version a native gitleaks reports (`gitleaks version`), or null when there is none. */
  readonly nativeVersion: () => string | null;
  readonly dockerAvailable: () => boolean;
  /** Whether `<root>/.git` is a directory, not a worktree's pointer file. */
  readonly gitDirIsLocal: () => boolean;
}

export interface IGitleaksOptions {
  /** The digest-pinned image to fall back to. Defaults to `GITLEAKS_IMAGE`. */
  readonly image?: string;
  /** The repo config the scan reads. Defaults to `.gitleaks.toml`. */
  readonly config?: string;
  /** Where the version came from, for the blocked reason (for example the workflow path). */
  readonly versionSource?: string;
}

export function chooseGitleaksRoute(
  version: string | null,
  root: string,
  deps: IGitleaksDeps,
  options: IGitleaksOptions = {},
): GitleaksRoute {
  const image = options.image ?? GITLEAKS_IMAGE;
  const args = gitleaksArgs(options.config);
  if (version === null) {
    const source = options.versionSource ?? 'the CI workflow';
    return { kind: 'blocked', reason: `${source} names no gitleaks version` };
  }
  const found = deps.nativeVersion();
  if (found === version) {
    return { kind: 'native', command: 'gitleaks', args };
  }
  const native =
    found === null ? 'no native gitleaks' : `native gitleaks ${found} is not CI's ${version}`;
  if (!deps.dockerAvailable()) {
    return {
      kind: 'blocked',
      reason: `${native}, and no Docker daemon answered. Install gitleaks ${version} (brew or scoop install gitleaks) or start Docker.`,
    };
  }
  if (!deps.gitDirIsLocal()) {
    return {
      kind: 'blocked',
      reason: `${native}, and this checkout's .git is a worktree pointer the image cannot follow. Install gitleaks ${version} (brew or scoop install gitleaks).`,
    };
  }
  if (imageVersion(image) !== version) {
    return {
      kind: 'blocked',
      reason: `${native}, and the pinned image ${image} is not CI's ${version}: re-pin the gitleaks image to that version.`,
    };
  }
  return {
    kind: 'docker',
    image,
    args: ['run', '--rm', '-v', `${root}:/repo:ro`, '-w', '/repo', image, ...args],
  };
}

export interface IGitleaksRunDeps extends IGitleaksDeps {
  /** Run from `cwd` with the output shown; the exit code, or null when it could not start. */
  readonly spawn: (command: string, args: readonly string[], cwd: string) => number | null;
}

export interface IGitleaksResult {
  readonly route: GitleaksRoute;
  readonly status: LinterStatus;
  readonly reason: string;
}

/**
 * Find gitleaks, scan, and judge the scan. No route, a scan that could not
 * start, and docker's own exit 125 are blocked, never passed; exit 0 is
 * passed; any other exit is failed.
 */
export function runGitleaks(
  version: string | null,
  root: string,
  deps: IGitleaksRunDeps,
  options: IGitleaksOptions = {},
): IGitleaksResult {
  const route = chooseGitleaksRoute(version, root, deps, options);
  if (route.kind === 'blocked') return { route, status: 'blocked', reason: route.reason };
  const command = route.kind === 'native' ? route.command : 'docker';
  const code = deps.spawn(command, route.args, root);
  if (code === null) {
    return { route, status: 'blocked', reason: `${command} could not be started` };
  }
  return { route, ...linterVerdict(route, code) };
}
