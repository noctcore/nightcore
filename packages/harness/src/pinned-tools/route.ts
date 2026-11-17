/*
 * How a check finds a pinned linter, in order (chooseRoute):
 *   1. a native binary on PATH that reports exactly the pinned version
 *      (and every tool it `needs`, at theirs);
 *   2. the pinned image by digest, when a Docker daemon answers;
 *   3. neither: BLOCKED, exit 2. A check that could not run is never a pass.
 * CI takes route 1 after `fetchPinned` installs the pinned archives. On a Mac
 * or Windows machine route 2 needs nothing installed but Docker.
 */
import type { ILinterPin, IToolPin } from './pins.js';

/** The first x.y.z a `--version` output names, or null. */
export function parseVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/u.exec(output)?.[1] ?? null;
}

/**
 * What the check runs. `native` and `docker` carry the argv to spawn, from the
 * repo root; `blocked` says why nothing can run.
 */
export type LinterRoute =
  | { readonly kind: 'native'; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: 'docker'; readonly image: string; readonly args: readonly string[] }
  | { readonly kind: 'blocked'; readonly reason: string };

export type LinterStatus = 'passed' | 'failed' | 'blocked';

export interface IRouteDeps {
  /** The version a native tool on PATH reports, or null when there is none. */
  readonly nativeVersion: (tool: IToolPin) => string | null;
  readonly dockerAvailable: () => boolean;
}

/**
 * The arguments a workflow linter runs with, the same on both routes.
 * `workflows` are the repo-relative workflow files, named explicitly:
 * actionlint left to find them itself needs a `.git` it can see (a worktree's
 * `.git` points outside the mount) and passes when it finds none.
 */
export function lintArgs(
  pin: ILinterPin,
  route: 'native' | 'docker',
  workflows: readonly string[],
): readonly string[] {
  if (pin.name === 'zizmor') {
    // --offline: no GitHub API calls, so the verdict never depends on the network
    // or a token. Every finding of the default persona fails; a deliberate one
    // is ignored in a zizmor.yml with its reason, never by a lower level here.
    return ['--offline', '--no-progress', ...workflows];
  }
  if (pin.name === 'actionlint') {
    // -pyflakes= turns off the python linter the image carries and a native
    // install lacks, so both routes check exactly the same things.
    return [
      '-no-color',
      '-pyflakes=',
      ...(route === 'native' ? ['-shellcheck=shellcheck'] : []),
      ...workflows,
    ];
  }
  throw new Error(`lintArgs: no arguments are known for the linter "${pin.name}"`);
}

/** `docker run` for the pinned image, with the repo mounted read-only as the working directory. */
export function dockerRunArgs(
  pin: ILinterPin,
  root: string,
  workflows: readonly string[],
): readonly string[] {
  return [
    'run',
    '--rm',
    ...(pin.platform === undefined ? [] : ['--platform', pin.platform]),
    '-v',
    `${root}:/repo:ro`,
    '-w',
    '/repo',
    pin.image,
    ...lintArgs(pin, 'docker', workflows),
  ];
}

function describeNative(tool: IToolPin, found: string | null): string {
  return found === null
    ? `no native ${tool.name}`
    : `native ${tool.name} ${found} is not the pinned ${tool.version}`;
}

export function chooseRoute(
  pin: ILinterPin,
  root: string,
  workflows: readonly string[],
  deps: IRouteDeps,
): LinterRoute {
  const tools = [pin, ...pin.needs];
  const mismatches = tools
    .map((tool) => ({ tool, found: deps.nativeVersion(tool) }))
    .filter(({ tool, found }) => found !== tool.version);
  if (mismatches.length === 0) {
    return { kind: 'native', command: pin.name, args: lintArgs(pin, 'native', workflows) };
  }
  if (deps.dockerAvailable()) {
    return { kind: 'docker', image: pin.image, args: dockerRunArgs(pin, root, workflows) };
  }
  const why = mismatches.map(({ tool, found }) => describeNative(tool, found)).join(', ');
  const wanted = tools.map((tool) => `${tool.name} ${tool.version}`).join(' and ');
  return {
    kind: 'blocked',
    reason:
      `${why}, and no Docker daemon answered for the pinned image. Start Docker, or install ` +
      `${wanted} (brew or scoop install ${tools.map((tool) => tool.name).join(' ')}).`,
  };
}

/*
 * `docker run` exits 125 when Docker itself failed (the daemon went away, the
 * image could not be pulled): the linter never ran. Everything else is the
 * linter's own exit: 0 clean; zizmor 10-14 and actionlint 1 are findings;
 * any other code is the tool failing, which is a failure, not "could not check".
 */
export function linterVerdict(
  route: LinterRoute,
  exitCode: number,
): { readonly status: LinterStatus; readonly reason: string } {
  if (route.kind === 'blocked') return { status: 'blocked', reason: route.reason };
  const via = route.kind === 'native' ? 'native' : 'pinned image';
  if (route.kind === 'docker' && exitCode === 125) {
    return { status: 'blocked', reason: 'docker could not run the pinned image (exit 125)' };
  }
  if (exitCode === 0) return { status: 'passed', reason: `no findings, ${via}` };
  return { status: 'failed', reason: `exit ${String(exitCode)}, ${via}: see the findings above` };
}

/** The exit code a verdict leaves with: 0 passed, 1 failed, 2 blocked. */
export function exitCodeFor(status: LinterStatus): number {
  return status === 'passed' ? 0 : status === 'failed' ? 1 : 2;
}

export interface IRunDeps extends IRouteDeps {
  /** The repo-relative `.github/workflows/*.y(a)ml` files under `root`, with `/` separators. */
  readonly workflows: (root: string) => readonly string[];
  /** Whether the image is already local, so nothing needs pulling. */
  readonly imagePresent: (image: string) => boolean;
  /** Pull the image; false when it could not be pulled (no network, no registry). */
  readonly pull: (image: string) => boolean;
  /** Run from `cwd` with the output shown; the exit code, or null when it could not start. */
  readonly spawn: (command: string, args: readonly string[], cwd: string) => number | null;
}

export interface ILinterResult {
  readonly route: LinterRoute;
  readonly status: LinterStatus;
  readonly reason: string;
}

/** Find the tool, run it on the repo's workflows, and judge the run. */
export function runLinter(pin: ILinterPin, root: string, deps: IRunDeps): ILinterResult {
  const workflows = deps.workflows(root);
  if (workflows.length === 0) {
    const route: LinterRoute = { kind: 'blocked', reason: 'no workflow files' };
    // Nothing to lint is a failure, never a pass: the path moved, or the tree is wrong.
    return { route, status: 'failed', reason: `no .github/workflows/*.yml under ${root}` };
  }
  const route = chooseRoute(pin, root, workflows, deps);
  if (route.kind === 'blocked') return { route, ...linterVerdict(route, 2) };
  if (route.kind === 'docker' && !deps.imagePresent(route.image) && !deps.pull(route.image)) {
    return {
      route,
      status: 'blocked',
      reason: `could not pull the pinned image ${route.image} (no network or registry)`,
    };
  }
  const command = route.kind === 'native' ? route.command : 'docker';
  const code = deps.spawn(command, route.args, root);
  if (code === null) {
    return { route, status: 'blocked', reason: `${command} could not be started` };
  }
  return { route, ...linterVerdict(route, code) };
}
