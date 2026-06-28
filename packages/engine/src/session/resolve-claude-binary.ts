/**
 * Resolve a real, on-disk `claude` executable to hand the SDK, working around the
 * `bun build --compile` `$bunfs` bundling that breaks the SDK's own binary
 * self-resolution. Exposes the resolver plus a few helpers it composes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { whichSync } from '@nightcore/shared';

/**
 * Resolve a path to the `claude` executable to hand the SDK via
 * `Options.pathToClaudeCodeExecutable`.
 *
 * WHY THIS EXISTS: the SDK normally locates its bundled, version-pinned `claude`
 * binary at runtime by `require.resolve`-ing the platform sibling package
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`) relative to its own
 * `import.meta.url`. That works under `bun run` (source/dev), but a
 * `bun build --compile` distributable bundles the SDK's JS into Bun's virtual
 * `$bunfs`, so the SDK's `import.meta.url` becomes `file:///$bunfs/root/…` and its
 * `require.resolve` of the on-disk sibling FAILS — the binary boots, accepts
 * commands, then crashes at session init with "Native CLI binary for
 * <platform>-<arch> not found.". We avoid that by resolving a REAL on-disk
 * `claude` ourselves and passing it explicitly.
 *
 * Resolution order (first hit wins; every probe degrades to the next on failure):
 *
 *   1. `NIGHTCORE_CLAUDE_PATH` if set and it exists on disk — explicit override.
 *   2. The SDK's own version-pinned platform package `claude`, resolved to an
 *      ABSOLUTE, real, executable path (never a `$bunfs:` virtual path). This is
 *      the version-matched binary the SDK would have used, so it is always safe to
 *      prefer — first via `require.resolve` (works in dev), then by scanning
 *      node_modules roots anchored at real on-disk paths (works inside the
 *      compiled binary, where `require.resolve` is `$bunfs`-broken).
 *   3. If `NIGHTCORE_USE_SYSTEM_CLAUDE` is truthy, whatever `which claude` resolves
 *      to on PATH — explicit opt-in to a possibly version-mismatched global CLI.
 *   4. As a last resort (the version-pinned package was not found at all), a
 *      `claude` on PATH or in a known global install location, so a compiled
 *      binary on a machine that has Claude Code installed but no SDK node_modules
 *      still runs rather than crashing.
 *   5. `undefined` — leave the SDK's own resolution in place (identical to the
 *      pre-fix behavior; we never hand the SDK a path we couldn't verify).
 *
 * CRITICAL: we never return a `$bunfs`/virtual path or a non-existent file — every
 * candidate is verified to be a real, executable file before being returned. If
 * nothing resolves we return `undefined` and let the SDK try, rather than passing
 * a broken path that would fail differently.
 */
export function resolveClaudeBinary(): string | undefined {
  const fromEnv = process.env.NIGHTCORE_CLAUDE_PATH;
  if (fromEnv && isRealExecutable(fromEnv)) return fromEnv;

  const fromPackage = resolvePlatformPackageBinary();
  if (fromPackage) return fromPackage;

  if (isTruthyEnv(process.env.NIGHTCORE_USE_SYSTEM_CLAUDE)) {
    const onPath = resolveOnPathOrGlobal();
    if (onPath) return onPath;
  }

  // Last resort: the version-pinned package was unreachable (e.g. a compiled
  // binary shipped to a machine with Claude Code installed but no SDK
  // node_modules). Prefer a real on-disk CLI over crashing at session init.
  return resolveOnPathOrGlobal();
}

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * Resolve the SDK's version-pinned native `claude` to a real, absolute, on-disk
 * path. Mirrors the SDK's own platform/arch/musl candidate ordering so we pick
 * the same binary it would have, then tries two resolution strategies:
 *
 *   a. `require.resolve(<pkg>/claude)` — succeeds under `bun run` (real
 *      node_modules on disk) and returns an absolute path.
 *   b. Scanning `node_modules` roots anchored at real on-disk locations
 *      (`dirname(process.execPath)`, `process.cwd()`, this module's own dir,
 *      each walked up to the filesystem root) — the compiled-binary path, where
 *      (a) fails because the SDK's `import.meta.url` lives in `$bunfs`.
 *
 * Returns `undefined` if no candidate resolves to a real executable file.
 */
function resolvePlatformPackageBinary(): string | undefined {
  const candidates = platformPackageSpecifiers();

  const req = createRequire(import.meta.url);
  for (const specifier of candidates) {
    try {
      const resolved = req.resolve(specifier);
      if (isRealExecutable(resolved)) return resolved;
    } catch {
      // require.resolve throws inside a compiled $bunfs binary — fall through to
      // the node_modules scan below.
    }
  }

  for (const root of nodeModulesRoots()) {
    for (const specifier of candidates) {
      const full = path.join(root, ...specifier.split('/'));
      if (isRealExecutable(full)) return full;
    }
  }

  return undefined;
}

/**
 * The `<pkg>-<platform>-<arch>/claude` specifiers the SDK would try, in the SDK's
 * own preference order (musl-first on musl linux, `.exe` on Windows). Kept in
 * sync with the SDK's internal resolver so we never select a different-version
 * binary than the one it ships.
 */
export function platformPackageSpecifiers(): string[] {
  const { platform, arch } = process;
  const exe = platform === 'win32' ? '.exe' : '';

  let bases: string[];
  if (platform === 'android') {
    bases = [`${SDK_PACKAGE}-linux-${arch}-android`];
  } else if (platform === 'linux') {
    bases = isMuslLinux()
      ? [`${SDK_PACKAGE}-linux-${arch}-musl`, `${SDK_PACKAGE}-linux-${arch}`]
      : [`${SDK_PACKAGE}-linux-${arch}`, `${SDK_PACKAGE}-linux-${arch}-musl`];
  } else {
    bases = [`${SDK_PACKAGE}-${platform}-${arch}`];
  }

  return bases.map((base) => `${base}/claude${exe}`);
}

/**
 * Mirror the SDK's musl detection: only relevant on linux, where a missing
 * `glibcVersionRuntime` in the process report signals a musl libc (Alpine etc.).
 */
function isMuslLinux(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const report =
      typeof process.report?.getReport === 'function'
        ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
        : null;
    return report != null && report.header?.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

/**
 * Real on-disk `node_modules` directories to scan, anchored at paths that stay
 * valid inside a compiled binary. `import.meta.dir` is `$bunfs`-virtual there, so
 * `process.execPath` (the real binary location) and `process.cwd()` are the load-
 * bearing anchors; the module dir is included for the dev/source case. Each anchor
 * is walked up to the filesystem root so a hoisted root `node_modules` is found
 * regardless of how deep the binary sits. Order: nearest-to-binary first.
 */
function nodeModulesRoots(): string[] {
  const anchors = [
    safeDirname(process.execPath),
    process.cwd(),
    moduleDir(),
  ].filter((a): a is string => a !== undefined);

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    for (const dir of ancestors(anchor)) {
      const candidate = path.join(dir, 'node_modules');
      if (!seen.has(candidate)) {
        seen.add(candidate);
        roots.push(candidate);
      }
    }
  }
  return roots;
}

/** Every directory from `start` up to the filesystem root, inclusive, nearest
 *  first. Used to find a hoisted `node_modules` regardless of nesting depth. */
export function ancestors(start: string): string[] {
  const out: string[] = [];
  let current = path.resolve(start);
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/**
 * Last-resort lookup of a `claude` outside the SDK package: PATH first, then a
 * handful of conventional global install locations. Returns a real executable
 * path or `undefined`.
 */
function resolveOnPathOrGlobal(): string | undefined {
  // `whichSync` is cross-platform (`where` on Windows, `which` elsewhere) and
  // returns null on any failure, so a missing tool degrades rather than throws.
  const onPath = whichSync('claude');
  if (onPath && isRealExecutable(onPath)) return onPath;

  for (const candidate of globalInstallCandidates()) {
    if (isRealExecutable(candidate)) return candidate;
  }
  return undefined;
}

function globalInstallCandidates(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const candidates: string[] = [];
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(process.env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'),
      );
    }
    if (home) {
      candidates.push(path.join(home, '.local', 'bin', 'claude.exe'));
    }
    return candidates;
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
}

/**
 * True only for a real, regular, executable file on the actual filesystem. This
 * is the guardrail that keeps a `$bunfs:`/virtual path or a non-existent file from
 * ever being handed to the SDK: a `$bunfs` path is not a real filesystem entry, so
 * `fs.statSync` reports it as non-existent here. Executability is checked via
 * `X_OK` on POSIX; on Windows the access bit is meaningless, so existence as a
 * regular file is sufficient.
 */
export function isRealExecutable(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function safeDirname(p: string | undefined): string | undefined {
  if (!p) return undefined;
  try {
    return path.dirname(path.resolve(p));
  } catch {
    return undefined;
  }
}

/**
 * This module's own directory, used as a dev/source anchor. `import.meta.url` is a
 * `$bunfs` virtual URL inside the compiled binary; `fileURLToPath` would yield a
 * virtual path that `ancestors()` walks but `isRealExecutable()` rejects —
 * harmless, and it correctly anchors the on-disk node_modules under `bun run`.
 */
function moduleDir(): string | undefined {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

/** Treat an env-var value as truthy unless it is unset, empty, `'0'`, or
 *  `'false'`. */
export function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}
