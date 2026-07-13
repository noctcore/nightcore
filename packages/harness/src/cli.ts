#!/usr/bin/env node
/**
 * `@noctcore/harness` CLI — the portable Structure-Lock runner. Thin arg
 * parsing + subcommand dispatch over {@link loadChecks} and {@link runChecks};
 * runs under plain Node ≥ 22 with zero runtime dependencies.
 *
 * `runCli` is pure over an injected {@link CliIO}, so the whole dispatch is
 * unit-testable in-process without touching the real filesystem or spawning.
 * The module self-invokes only when executed as the `harness` bin (a
 * symlink-safe entry check), never on import.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createNodeCtx } from './lint-meta/ctx.js';
import {
  DEFAULT_REGISTRY_RELATIVE_PATH,
  defaultImporter,
  loadRegistry,
  type ModuleImporter,
} from './lint-meta/registry.js';
import { exitCodeFor, reportMetaOutcomes, runMetaRules } from './lint-meta/run.js';
import { type FileReader,loadChecks } from './manifest.js';
import { emptyPass, fixInstruction, runChecks, type SpawnFn } from './run.js';

/** The side-effecting surface `runCli` depends on — real or faked in tests. */
export interface CliIO {
  cwd: string;
  read: FileReader;
  spawn: SpawnFn;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /**
   * Dynamic module import for the `lint-meta` bounded eval — real (`defaultImporter`)
   * or a recording fake in tests. Optional: the `check` path never imports, and
   * `runLintMeta` falls back to {@link defaultImporter} when it is absent.
   */
  importModule?: ModuleImporter;
}

const HELP = `@noctcore/harness — portable Structure-Lock runner

Usage:
  harness [check] [options]      Run the checks declared in .nightcore/harness.json
  harness lint-meta [options]    Run the portable lint-meta rules from the enumerated registry

Options:
  --dir <path>        Target directory to operate in (default: current directory)
  --registry <path>   lint-meta only: the rule registry to load
                      (default: ${DEFAULT_REGISTRY_RELATIVE_PATH}, relative to --dir)
  --json              check only: emit the machine-readable result to stdout instead of a summary
  --version           Print the runner version and exit
  --help              Print this help and exit

Exit codes:
  0  every check/rule passed (or nothing is configured to enforce)
  1  a check failed, a rule reported a critical violation or threw, or the manifest requires a newer runner
  2  a usage error`;

interface ParsedArgs {
  command: string;
  dir: string;
  /** lint-meta: an explicit registry path (`--registry`), else the fixed default. */
  registry: string | undefined;
  json: boolean;
  help: boolean;
  version: boolean;
}

/** Parse argv into a subcommand + flags, resolving `--dir` against `cwd`. */
function parseArgs(argv: string[], cwd: string): ParsedArgs {
  let command = 'check';
  let sawCommand = false;
  let dir = cwd;
  let registry: string | undefined;
  let json = false;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--dir') {
      const next = argv[i + 1];
      if (next !== undefined) {
        dir = next;
        i += 1;
      }
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length);
    } else if (arg === '--registry') {
      const next = argv[i + 1];
      if (next !== undefined) {
        registry = next;
        i += 1;
      }
    } else if (arg.startsWith('--registry=')) {
      registry = arg.slice('--registry='.length);
    } else if (!arg.startsWith('-') && !sawCommand) {
      command = arg;
      sawCommand = true;
    }
  }

  return { command, dir: path.resolve(cwd, dir), registry, json, help, version };
}

/** Read this package's version from its committed `package.json`. */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The real Node-backed IO: `node:fs` reads and `node:child_process` spawns. */
export function nodeIO(): CliIO {
  return {
    cwd: process.cwd(),
    read(absolutePath) {
      try {
        return readFileSync(absolutePath, 'utf8');
      } catch {
        return null;
      }
    },
    spawn(program, args, options) {
      const res = spawnSync(program, args, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      });
      const err = res.error as NodeJS.ErrnoException | undefined;
      return {
        status: res.status,
        signal: res.signal,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
        error: err ? { code: err.code, message: err.message } : undefined,
      };
    },
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    importModule: defaultImporter,
  };
}

/** Run the `check` subcommand. Returns the process exit code. */
function runCheck(parsed: ParsedArgs, io: CliIO): number {
  const outcome = loadChecks(parsed.dir, io.read);

  if (outcome.kind === 'no-config') {
    if (parsed.json) {
      io.stdout(JSON.stringify(emptyPass()));
    } else {
      io.stdout('No structure lock configured — nothing to enforce.');
    }
    return 0;
  }

  if (outcome.kind === 'schema-too-new') {
    const label = Number.isFinite(outcome.found)
      ? String(outcome.found)
      : 'an unrecognized value';
    io.stderr(
      `This .nightcore/harness.json declares schemaVersion ${label}, which this ` +
        'runner does not understand. This bundle was authored by a newer ' +
        'Nightcore — upgrade @noctcore/harness.',
    );
    return 1;
  }

  const result = runChecks(outcome.checks, parsed.dir, io.spawn, (check) => {
    // Legibility (§5): echo every command before it runs. In `--json` mode this
    // goes to stderr so stdout stays a single parseable JSON document.
    const line = `→ ${check.name}: ${check.command}`;
    if (parsed.json) io.stderr(line);
    else io.stdout(line);
  });

  if (parsed.json) {
    io.stdout(JSON.stringify(result));
    return result.passed ? 0 : 1;
  }

  for (const check of result.checks) {
    const mark = check.status === 'passed' ? '✓' : '✗';
    const exit = check.exitCode != null ? ` (exit ${check.exitCode})` : '';
    io.stdout(`${mark} ${check.name}${exit}`);
  }

  if (result.passed) {
    const n = result.checks.length;
    io.stdout(`\nStructure lock passed (${n} check${n === 1 ? '' : 's'}).`);
    return 0;
  }

  io.stderr(`\n${fixInstruction(result)}`);
  return 1;
}

/**
 * Run the `lint-meta` subcommand: BOUNDED-EVAL the enumerated rule registry
 * (§3.5/§5) and run its rules against a real Node ctx rooted at the target dir.
 *
 * Opt-in-by-presence, mirroring `check`: an ABSENT registry ⇒ exit 0 ("nothing to
 * enforce"). A PRESENT-but-broken registry (import throws, or no `META_RULES`
 * array) reds the build — a bundle that meant to enforce rules must not silently
 * pass because its registry is malformed. Only the ONE declared registry file is
 * imported; a stray `.js` beside it is never loaded.
 */
async function runLintMeta(parsed: ParsedArgs, io: CliIO): Promise<number> {
  const registryPath = parsed.registry
    ? path.resolve(parsed.dir, parsed.registry)
    : path.join(parsed.dir, DEFAULT_REGISTRY_RELATIVE_PATH);

  // Presence check via a plain read (no import): an absent registry opts out.
  if (io.read(registryPath) === null) {
    io.stdout(
      `No lint-meta registry at ${registryPath} — nothing to enforce. ` +
        '(Point --registry at your rule registry, or commit one at ' +
        `${DEFAULT_REGISTRY_RELATIVE_PATH}.)`,
    );
    return 0;
  }

  const loaded = await loadRegistry(registryPath, io.importModule ?? defaultImporter);
  if (loaded.error !== undefined) {
    io.stderr(`Failed to load the lint-meta registry at ${registryPath}: ${loaded.error}`);
    return 1;
  }

  const n = loaded.rules.length;
  io.stdout(`lint-meta: running ${n} rule${n === 1 ? '' : 's'} from ${registryPath}`);

  const ctx = createNodeCtx(parsed.dir);
  // Legibility (§5): echo every rule before it runs.
  const outcomes = runMetaRules(loaded.rules, ctx, (rule) => io.stdout(`→ ${rule.id}`));
  const report = reportMetaOutcomes(outcomes);

  for (const line of report.lines) io.stderr(line);
  if (report.lines.length === 0) io.stdout('lint-meta: no violations');

  return exitCodeFor(report);
}

/**
 * Parse argv and dispatch. Returns the process exit code (never exits). The
 * `check` path stays synchronous (`number`); the `lint-meta` path is async
 * (bounded dynamic import), so the return type is `number | Promise<number>` and
 * the bin entry awaits it.
 */
export function runCli(argv: string[], io: CliIO = nodeIO()): number | Promise<number> {
  const parsed = parseArgs(argv, io.cwd);

  if (parsed.help) {
    io.stdout(HELP);
    return 0;
  }
  if (parsed.version) {
    io.stdout(readVersion());
    return 0;
  }
  if (parsed.command === 'check') return runCheck(parsed, io);
  if (parsed.command === 'lint-meta') return runLintMeta(parsed, io);
  io.stderr(`Unknown command: ${parsed.command}. Run \`harness --help\`.`);
  return 2;
}

/**
 * Whether this module is the process entry (the `harness` bin), resolving
 * symlinks on both sides so an `npx`/`node_modules/.bin` shim still matches.
 * False on import (keeps `runCli` unit-testable).
 */
function isMainModule(): boolean {
  try {
    const entry = process.argv[1];
    if (entry === undefined) return false;
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // `runCli` is sync for `check`/`--help`/`--version` and async for `lint-meta`
  // (bounded dynamic import); normalize both to a resolved exit code.
  void Promise.resolve(runCli(process.argv.slice(2))).then((code) => {
    process.exit(code);
  });
}
