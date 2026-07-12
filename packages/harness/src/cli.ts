#!/usr/bin/env node
/**
 * `@nightcore/harness` CLI — the portable Structure-Lock runner. Thin arg
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

import { type FileReader,loadChecks } from './manifest.js';
import { emptyPass, fixInstruction, runChecks, type SpawnFn } from './run.js';

/** The side-effecting surface `runCli` depends on — real or faked in tests. */
export interface CliIO {
  cwd: string;
  read: FileReader;
  spawn: SpawnFn;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const HELP = `@nightcore/harness — portable Structure-Lock runner

Usage:
  harness [check] [options]      Run the checks declared in .nightcore/harness.json

Options:
  --dir <path>   Target directory to check (default: current directory)
  --json         Emit the machine-readable result to stdout instead of a summary
  --version      Print the runner version and exit
  --help         Print this help and exit

Exit codes:
  0  every check passed (or no structure lock is configured)
  1  a check failed, or the manifest requires a newer runner
  2  a usage error`;

interface ParsedArgs {
  command: string;
  dir: string;
  json: boolean;
  help: boolean;
  version: boolean;
}

/** Parse argv into a subcommand + flags, resolving `--dir` against `cwd`. */
function parseArgs(argv: string[], cwd: string): ParsedArgs {
  let command = 'check';
  let sawCommand = false;
  let dir = cwd;
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
    } else if (!arg.startsWith('-') && !sawCommand) {
      command = arg;
      sawCommand = true;
    }
  }

  return { command, dir: path.resolve(cwd, dir), json, help, version };
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
        'Nightcore — upgrade @nightcore/harness.',
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

/** Parse argv and dispatch. Returns the process exit code (never exits). */
export function runCli(argv: string[], io: CliIO = nodeIO()): number {
  const parsed = parseArgs(argv, io.cwd);

  if (parsed.help) {
    io.stdout(HELP);
    return 0;
  }
  if (parsed.version) {
    io.stdout(readVersion());
    return 0;
  }
  if (parsed.command !== 'check') {
    io.stderr(`Unknown command: ${parsed.command}. Run \`harness --help\`.`);
    return 2;
  }
  return runCheck(parsed, io);
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
  process.exit(runCli(process.argv.slice(2)));
}
