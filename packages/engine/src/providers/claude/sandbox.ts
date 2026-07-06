/**
 * OPT-IN macOS OS-level WRITE containment for agent sessions (hardening module
 * #15, tier "OS containment" — the runtime half).
 *
 * Nightcore's runtime policy layer (the PreToolUse hooks) is LEXICAL: it
 * inspects tool inputs, so symlink writes, Bash redirect writes (`echo x >
 * /outside/file`), and other non-tool-mediated writers slip past it (documented
 * gaps). This module closes those gaps at the OS layer by wrapping the `claude`
 * executable in Apple Seatbelt (`/usr/bin/sandbox-exec`) with a
 * deny-write-except profile.
 *
 * WRITE CONTAINMENT ONLY: the profile is `(allow default)` + `(deny
 * file-write*)` + explicit `(allow file-write* …)` roots — reads and network
 * stay fully allowed. This is deliberate: the goal is to stop an agent from
 * mutating files outside its workspace, not to air-gap it. (Read/network
 * containment would break the CLI's own credential/config resolution and is a
 * different, much larger profile.)
 *
 * Writable roots (empirically validated on darwin against the real CLI,
 * 2026-07-02 — a wrapped `claude -p` session completed green, the Write tool
 * created files in cwd, and a Bash redirect to `$HOME` failed with "operation
 * not permitted"):
 *  - the session cwd (the task worktree or project root);
 *  - the git COMMON dir when cwd is a linked worktree (`<repo>/.git` — git
 *    writes index/locks/objects/refs there even for worktree-local commits;
 *    without it every `git` command in a worktree session fails). The main
 *    checkout's WORKING TREE stays read-only, which is the whole point;
 *  - `/dev` (tty/null writes from shell commands — devices, not persistent
 *    storage);
 *  - the darwin temp trees: `realpath($TMPDIR)`, `/private/tmp`,
 *    `/private/var/folders`;
 *  - `~/.claude` (the CLI's state tree: shell snapshots, projects, todos,
 *    session state — observed on disk) EXCEPT the config-poisoning files carved
 *    back out below;
 *  - `~/Library/Caches/claude-cli-nodejs` (the CLI's cache/log dir — observed
 *    on disk).
 *
 * CONFIG-POISONING CARVE-OUT (denied even inside the writable `~/.claude` root):
 * an autonomous agent never needs to author the CLI's GLOBAL settings, and such
 * a write is a hook-injection RCE — a planted `hooks` entry in
 * `~/.claude/settings.json` (or `mcpServers` in the `~/.claude.json` family)
 * runs arbitrary shell on the NEXT session. So containment additionally DENIES
 * `~/.claude/settings.json`, `~/.claude/settings.local.json`, and the whole
 * `~/.claude.json*` family. The CLI's ephemeral session-state writes under
 * `~/.claude` (shell snapshots / todos / projects) stay allowed, so a wrapped
 * session still runs; only the two config surfaces an agent must never rewrite
 * are blocked.
 *
 * KNOWN CONSEQUENCE (accepted, feature is default-off + experimental): user
 * hooks configured in `~/.claude/settings.json` that write OUTSIDE these roots
 * fail under containment (observed: a GitKraken SessionEnd hook). That is the
 * containment doing its job — unexpected writers are exactly what it blocks.
 *
 * RESIDUAL GAP (documented): the wrapper + profile live in the temp tree,
 * which is itself writable from inside the sandbox — a contained agent could
 * tamper with ANOTHER concurrently-starting session's not-yet-exec'd wrapper.
 * The profile is read once at exec, so a running session's containment cannot
 * be altered.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Logger } from '@nightcore/shared';

/** The Seatbelt interpreter. An absolute, SIP-protected path — never resolved
 *  via PATH so a malicious `sandbox-exec` shim can't intercept the wrap. */
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** File names written into the per-session scratch dir. */
const PROFILE_FILE = 'write-containment.sb';
const WRAPPER_FILE = 'claude-sandboxed.sh';

/**
 * Escape a path for embedding in a Seatbelt profile string literal. Seatbelt
 * profiles are TinyScheme: double-quoted strings with backslash escapes.
 */
function seatbeltString(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Escape a path for embedding inside single quotes in a POSIX shell script. */
function shellSingleQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a deny-write-except Seatbelt profile: everything allowed EXCEPT
 * `file-write*`, which is re-allowed only under the given roots (`subpath`
 * filters — the root and everything beneath it) and prefixes (`prefix`
 * filters — any path whose string starts with the value). Optional
 * `denyWritePaths`/`denyWritePrefixes` are emitted AFTER the allow rules and,
 * because Seatbelt evaluates rules LAST-MATCH-WINS, they carve specific paths
 * back OUT of an allowed root — used to keep the CLI's `~/.claude` state tree
 * writable while still denying the config-poisoning files inside it
 * (`settings.json` hook-injection, the `~/.claude.json` mcp/hooks family). Pure:
 * no I/O, so profile generation is unit-testable without a darwin host.
 *
 * Callers must pass CANONICALIZED roots (see `deriveWritableRoots`): Seatbelt
 * evaluates the kernel-resolved (symlink-free) path, so `/tmp/x` is checked as
 * `/private/tmp/x` — a non-canonical root silently never matches.
 */
export function buildSeatbeltProfile(opts: {
  writableRoots: string[];
  writablePrefixes?: string[];
  denyWritePaths?: string[];
  denyWritePrefixes?: string[];
}): string {
  const lines = ['(version 1)', '(allow default)', '(deny file-write*)'];
  for (const root of opts.writableRoots) {
    lines.push(`(allow file-write* (subpath ${seatbeltString(root)}))`);
  }
  for (const prefix of opts.writablePrefixes ?? []) {
    lines.push(`(allow file-write* (prefix ${seatbeltString(prefix)}))`);
  }
  // Deny rules come LAST so they override the allows above for these exact
  // paths (last-match-wins). This is what re-protects the config-poisoning
  // files that sit inside an otherwise-writable state dir.
  for (const p of opts.denyWritePaths ?? []) {
    lines.push(`(deny file-write* (literal ${seatbeltString(p)}))`);
  }
  for (const prefix of opts.denyWritePrefixes ?? []) {
    lines.push(`(deny file-write* (prefix ${seatbeltString(prefix)}))`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Write the profile + a tiny exec wrapper into `scratchDir` and return the
 * wrapper path. The wrapper is a 0o755 shell script:
 *
 *   #!/bin/sh
 *   exec /usr/bin/sandbox-exec -f '<profile>' '<claudePath>' "$@"
 *
 * `exec` keeps the process tree flat (the SDK's child IS the sandboxed CLI, so
 * signals/interrupts behave identically to the unwrapped path). Args and stdio
 * pass through untouched, so the SDK cannot tell it isn't talking to `claude`
 * directly.
 */
export function wrapExecutableForSandbox(opts: {
  claudePath: string;
  profile: string;
  scratchDir: string;
}): string {
  const profilePath = path.join(opts.scratchDir, PROFILE_FILE);
  const wrapperPath = path.join(opts.scratchDir, WRAPPER_FILE);
  fs.writeFileSync(profilePath, opts.profile, { mode: 0o644 });
  const script =
    '#!/bin/sh\n' +
    `exec ${SANDBOX_EXEC} -f ${shellSingleQuote(profilePath)} ` +
    `${shellSingleQuote(opts.claudePath)} "$@"\n`;
  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
  return wrapperPath;
}

/** A do-nothing profile used only to prove `sandbox-exec` runs on this host. */
const PROBE_PROFILE = '(version 1)\n(allow default)\n';

let availabilityCache: boolean | undefined;

/**
 * Preflight probe: write containment is available only on darwin, with
 * `/usr/bin/sandbox-exec` present, AND a smoke run (`sandbox-exec -f
 * <allow-all profile> /usr/bin/true`) exiting 0 — the empirical check that the
 * Seatbelt runtime actually works here (it is deprecated-but-shipping; a future
 * macOS could remove it). Memoized: the answer cannot change mid-process.
 */
export function sandboxAvailable(): boolean {
  if (availabilityCache !== undefined) return availabilityCache;
  availabilityCache = probeSandbox();
  return availabilityCache;
}

/** Clear the memoized probe; for tests that fake the platform/filesystem. */
export function resetSandboxAvailabilityCacheForTest(): void {
  availabilityCache = undefined;
}

function probeSandbox(): boolean {
  if (process.platform !== 'darwin') return false;
  if (!fs.existsSync(SANDBOX_EXEC)) return false;
  let dir: string | undefined;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcore-sb-probe-'));
    const profilePath = path.join(dir, PROFILE_FILE);
    fs.writeFileSync(profilePath, PROBE_PROFILE);
    const result = spawnSync(SANDBOX_EXEC, ['-f', profilePath, '/usr/bin/true'], {
      timeout: 5_000,
    });
    return result.status === 0;
  } catch {
    return false;
  } finally {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `fs.realpathSync` that degrades to the input path (resolved absolute) when
 *  the target doesn't exist or can't be resolved — a missing optional root
 *  (e.g. a cache dir the CLI hasn't created yet) still gets an allow rule so
 *  the CLI can CREATE it. */
function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * When `cwd` is a LINKED git worktree, its `.git` is a FILE containing
 * `gitdir: <abs>/.git/worktrees/<name>`. Git operations inside the worktree
 * write to that common dir (index, locks, objects, refs), so containment must
 * allow the whole `<abs>/.git` — otherwise every `git` command in a worktree
 * session fails. Returns `[]` for a normal checkout (its `.git` DIRECTORY is
 * already under cwd) or a non-repo cwd. The parent WORKING TREE is deliberately
 * NOT allowed: an agent in a worktree writing to the main checkout is the
 * observed incident this feature exists to stop.
 */
export function gitCommonWriteRoots(cwd: string): string[] {
  const dotGit = path.join(cwd, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  let content: string;
  try {
    content = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return [];
  }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
  if (!match || match[1] === undefined) return [];
  const gitdir = path.resolve(cwd, match[1].trim());
  // `<repo>/.git/worktrees/<name>` → allow `<repo>/.git`. If the layout is
  // anything else (bare/odd setups), allow the pointed-to dir itself.
  const worktreesDir = path.dirname(gitdir);
  const commonDir =
    path.basename(worktreesDir) === 'worktrees'
      ? path.dirname(worktreesDir)
      : gitdir;
  return [realpathOr(commonDir)];
}

/**
 * The default writable-roots set for one session: the session cwd (+ project
 * root when the caller knows it and it differs), the git common dir for a
 * worktree cwd, the darwin temp trees, and the Claude CLI's own state/cache
 * dirs. Every root is canonicalized (Seatbelt matches kernel-resolved paths).
 * Deduplicated, order-stable.
 */
export function deriveWritableRoots(opts: {
  cwd: string;
  projectRoot?: string;
}): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    const real = realpathOr(p);
    if (!seen.has(real)) {
      seen.add(real);
      roots.push(real);
    }
  };

  add(opts.cwd);
  if (opts.projectRoot !== undefined) add(opts.projectRoot);
  for (const gitRoot of gitCommonWriteRoots(opts.cwd)) add(gitRoot);
  add('/dev');
  add(os.tmpdir());
  add('/private/tmp');
  add('/private/var/folders');
  add(path.join(home, '.claude'));
  add(path.join(home, 'Library', 'Caches', 'claude-cli-nodejs'));
  return roots;
}

/** The config-poisoning files DENIED even inside the writable `~/.claude` root
 *  (see the module doc): the global settings files whose `hooks` run arbitrary
 *  shell on the next session, as exact literals. */
export function claudeConfigPoisonPaths(): string[] {
  const claudeDir = path.join(os.homedir(), '.claude');
  return [
    path.join(claudeDir, 'settings.json'),
    path.join(claudeDir, 'settings.local.json'),
  ];
}

/** The config-poisoning PREFIX denials: the `~/.claude.json` family (the CLI
 *  writes `~/.claude.json`, `~/.claude.json.backup`, and timestamped
 *  `~/.claude.json.backup.<ts>` siblings), which can carry `mcpServers`/`hooks`
 *  that execute on the next session. A prefix rule covers the whole family.
 *  This is NO LONGER in the writable set — writing the CLI's global config is
 *  never a legitimate agent action, and permitting it undermines the very
 *  hook-injection defense the sandbox exists to provide. */
export function claudeConfigPoisonPrefixes(): string[] {
  return [path.join(os.homedir(), '.claude.json')];
}

/** What `prepareWriteSandbox` hands back on success: the wrapper to exec in
 *  place of `claude`, plus the profile/roots for logging + diagnostics. */
export interface PreparedWriteSandbox {
  wrapperPath: string;
  scratchDir: string;
  writableRoots: string[];
}

/**
 * The one-call orchestration the session runner uses: probe availability,
 * derive roots, build the profile, and write the wrapper into a fresh
 * per-session scratch dir. Returns `undefined` when containment was requested
 * but cannot be provided — after logging a LOUD warning — so the caller runs
 * UNwrapped (fail-open by design: the feature is experimental and default-off;
 * failing the session closed would strand every task on a machine where
 * Seatbelt breaks).
 */
export function prepareWriteSandbox(opts: {
  claudePath: string;
  cwd: string;
  projectRoot?: string;
  logger?: Logger;
}): PreparedWriteSandbox | undefined {
  if (!sandboxAvailable()) {
    opts.logger?.warn(
      'WRITE CONTAINMENT UNAVAILABLE: sandboxWrites was requested but this ' +
        'host cannot provide it (requires macOS with a working ' +
        '/usr/bin/sandbox-exec). The session will run WITHOUT OS-level write ' +
        'containment — only the lexical PreToolUse policy layer applies.',
      { platform: process.platform },
    );
    return undefined;
  }
  try {
    const writableRoots = deriveWritableRoots({
      cwd: opts.cwd,
      ...(opts.projectRoot !== undefined
        ? { projectRoot: opts.projectRoot }
        : {}),
    });
    const profile = buildSeatbeltProfile({
      writableRoots,
      // Carve the config-poisoning surfaces back OUT of the writable `~/.claude`
      // root (and deny the `~/.claude.json` family entirely) — these are the
      // hook-injection RCE vectors an agent must never write, even with the
      // sandbox on. Session state under `~/.claude` stays writable.
      denyWritePaths: claudeConfigPoisonPaths(),
      denyWritePrefixes: claudeConfigPoisonPrefixes(),
    });
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nightcore-sandbox-'),
    );
    const wrapperPath = wrapExecutableForSandbox({
      claudePath: opts.claudePath,
      profile,
      scratchDir,
    });
    return { wrapperPath, scratchDir, writableRoots };
  } catch (error) {
    opts.logger?.warn(
      'WRITE CONTAINMENT SETUP FAILED: sandboxWrites was requested but the ' +
        'profile/wrapper could not be written. The session will run WITHOUT ' +
        'OS-level write containment.',
      error,
    );
    return undefined;
  }
}
