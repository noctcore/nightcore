/**
 * The workspace-confinement rule family (`workspace-confinement` rule id): the
 * native file-mutation tools (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`), the
 * multi-target `ApplyPatch` parse, and the best-effort lexical `Bash` write/`cd`
 * escape scan. Extracted from `workspace-confinement.ts`; the orchestrator that
 * dispatches to it — and the module-level documentation of scope/limits — stays in
 * that facade. The Bash scan is LEXICAL and best-effort by design (real containment
 * is the OS sandbox); it reuses `parseCommandLine` from the deny policy.
 */
import * as path from 'node:path';

import { parseCommandLine } from '../tool-deny-policy.js';
import { HOME_DIR, isAllowedTarget } from './paths.js';

/** Stable id surfaced in logs/telemetry when the confinement gate denies. */
export const WORKSPACE_CONFINEMENT_RULE_ID = 'workspace-confinement';

/** Mutation tools whose target path is inspected → the input key holding it.
 *  Exported so the harness-policy gate (protected paths) confines the SAME tool
 *  set — one source of the "which native tools mutate files" fact.
 *
 *  `ApplyPatch` is a special case: its single `file_path` key (when present) is
 *  listed here so the harness protected-path gate inspects it too, but its real
 *  target set is a PATCH BODY that can name MANY files, so workspace confinement
 *  handles it via a dedicated branch ({@link APPLY_PATCH_TOOL}) that parses every
 *  target out of the patch and fail-closes when none is inspectable. */
export const FILE_MUTATION_TARGET_KEY: Record<string, 'file_path' | 'notebook_path'> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  ApplyPatch: 'file_path',
};

/** The native patch-apply tool. Unlike the other mutation tools it does not carry
 *  a single target path — its input is an apply-patch envelope whose body names
 *  every file it Adds/Updates/Deletes/Moves — so confinement parses ALL targets
 *  out of it (below) rather than reading one key. It is a recognized file-mutating
 *  tool (Nightcore's `WRITE_TOOLS` lists it), so an unconfined `ApplyPatch` would
 *  re-open the exact worktree-escape this gate exists to close. */
export const APPLY_PATCH_TOOL = 'ApplyPatch';

/** Apply-patch envelope lines that name a mutated file (OpenAI apply_patch
 *  format: `*** Add File: a/b.ts`, `*** Update File: …`, `*** Delete File: …`,
 *  and a rename's `*** Move to: …`). Global + multiline + case-insensitive so
 *  every target in a multi-file patch is captured. */
const APPLY_PATCH_FILE_MARKER =
  /^\*\*\*\s+(?:Add File|Update File|Delete File|Move to|Move File to|Rename to):\s*(.+?)\s*$/gim;

/** Every filesystem target an `ApplyPatch` call would mutate: a direct `file_path`
 *  arg (when the shape carries one) PLUS every path named in an apply-patch body
 *  found in any string field of the input (the body's field name varies by SDK
 *  shape, so all string values are scanned). Empty ⇒ nothing inspectable, which
 *  the caller treats as fail-closed (an uncontained mutation can't be verified). */
export function extractApplyPatchTargets(toolInput: unknown): string[] {
  if (toolInput === null || typeof toolInput !== 'object') return [];
  const rec = toolInput as Record<string, unknown>;
  const targets = new Set<string>();
  const direct = rec['file_path'];
  if (typeof direct === 'string' && direct.length > 0) targets.add(direct);
  for (const value of Object.values(rec)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    APPLY_PATCH_FILE_MARKER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = APPLY_PATCH_FILE_MARKER.exec(value)) !== null) {
      const captured = match[1]?.trim();
      if (captured !== undefined && captured.length > 0) targets.add(captured);
    }
  }
  return [...targets];
}

/** The first ABSOLUTE `cd`/`pushd` target in a bash line that escapes the allowed
 *  roots, or undefined. Best-effort and NARROW by design: a relative `cd` is out
 *  of scope (a relative `cd ..` CAN escape, but Bash writes are unconfined anyway
 *  — see the header), and a dynamic target (`$(…)`, `~`) can't be resolved
 *  lexically — so both are left alone. This only catches the high-signal
 *  `cd /absolute/outside` form (the exact vector observed in the reported bug). */
export function bashCdEscape(toolInput: unknown, roots: readonly string[]): string | undefined {
  if (toolInput === null || typeof toolInput !== 'object') return undefined;
  const command = (toolInput as { command?: unknown }).command;
  if (typeof command !== 'string') return undefined;
  for (const cmd of parseCommandLine(command)) {
    const word = cmd[0];
    if (word !== 'cd' && word !== 'pushd') continue;
    // First non-flag operand is the destination (`cd -P /path` → `/path`).
    const arg = cmd.slice(1).find((t) => !t.startsWith('-'));
    if (arg === undefined || !path.isAbsolute(arg)) continue;
    const resolved = path.resolve(arg);
    if (!isAllowedTarget(resolved, roots)) return resolved;
  }
  return undefined;
}

/** Basename of a bash token (`/usr/bin/tee` → `tee`), handling both separators so
 *  a path-qualified write tool can't dodge the command-word check. */
function bashBasename(token: string): string {
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1] ?? token;
}

/** Shell interpreters whose `-c <script>` argument is itself a command line, so the
 *  write-escape scan recurses into it — `sh -c 'echo x > /abs'` must not hide the
 *  write behind a subshell. */
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
]);

/**
 * Lexically resolve a bash write-target TOKEN to an absolute path — and ONLY when
 * it can be resolved without runtime state: an absolute path, a `~`/`~/…` home
 * path, or a `$HOME`/`${HOME}` home path. A relative or otherwise dynamic target
 * (`out.txt`, `../x`, `$VAR/x`, `$(…)`) returns undefined and is left alone (same
 * narrow, high-signal posture as {@link bashCdEscape} — real containment is the OS
 * sandbox). The `~`/`$HOME` handling is what lets the gate catch the marquee
 * `> ~/.claude/settings.json` config-poisoning vector even though `~` is not an
 * absolute path.
 */
function lexicalWriteTarget(token: string): string | undefined {
  if (token.length === 0) return undefined;
  if (HOME_DIR.length > 0) {
    if (token === '~') return HOME_DIR;
    if (token.startsWith('~/')) return path.resolve(HOME_DIR, token.slice(2));
    const homeVar = /^\$(?:HOME|\{HOME\})(?:\/(.*))?$/.exec(token);
    if (homeVar !== null) {
      return homeVar[1] !== undefined && homeVar[1].length > 0
        ? path.resolve(HOME_DIR, homeVar[1])
        : HOME_DIR;
    }
  }
  if (path.isAbsolute(token)) return path.resolve(token);
  return undefined;
}

/** True when a resolved absolute write target escapes the allowed roots. `/dev/*`
 *  pseudo-devices (`/dev/null`, `/dev/stdout`, `2>/dev/null`) are NOT escapes —
 *  they are benign sinks, and a raw block-device write is the destructive deny
 *  list's job, not confinement's. */
function isBashWriteEscape(resolved: string, roots: readonly string[]): boolean {
  if (resolved === '/dev/null' || resolved.startsWith('/dev/')) return false;
  return !isAllowedTarget(resolved, roots);
}

/** Every WRITE destination token in one simple command: redirect targets, plus the
 *  destination operand(s) of the write-oriented tools we recognize (`tee`, `cp`,
 *  `mv`, `install`, `dd of=`, `ln`, `sed -i`). Read-only operands (a `cp` SOURCE,
 *  a `sed` script expression) are deliberately excluded — resolving a source path
 *  would false-positive on a legitimate read of an absolute file. */
function collectBashWriteTargets(cmd: readonly string[]): string[] {
  const targets: string[] = [];
  // Redirects: `>`/`>>` with an optional fd or `&` prefix, target glued or spaced
  // (`>/abs`, `>> /abs`, `2>/abs`, `&>/abs`). `2>&1`/`>&2` capture `&1`/`&2`, which
  // `lexicalWriteTarget` ignores (not a path).
  for (let i = 0; i < cmd.length; i += 1) {
    const redirect = /^(?:[0-9]*|&)>>?(.*)$/.exec(cmd[i]!);
    if (redirect === null) continue;
    const glued = redirect[1]!;
    targets.push(glued.length > 0 ? glued : (cmd[i + 1] ?? ''));
  }
  const word = cmd.length > 0 ? bashBasename(cmd[0]!) : '';
  const rest = cmd.slice(1);
  const nonFlag = rest.filter((t) => !t.startsWith('-'));
  if (word === 'tee' || word === 'ln') {
    // tee writes every file operand; ln creates a link — flag either operand (an
    // in-cwd link pointing OUT is a two-step escape; a link placed OUT is direct).
    for (const t of nonFlag) targets.push(t);
  } else if (word === 'cp' || word === 'mv' || word === 'install') {
    // The final operand is the destination; earlier operands are read sources. A
    // `-t DIR` / `--target-directory[=DIR]` flag names the dest explicitly.
    const ti = rest.findIndex(
      (t) => t === '-t' || t === '--target-directory',
    );
    const glued = rest.find((t) => t.startsWith('--target-directory='));
    if (ti !== -1 && rest[ti + 1] !== undefined) targets.push(rest[ti + 1]!);
    else if (glued !== undefined) targets.push(glued.slice('--target-directory='.length));
    else {
      const dest = nonFlag[nonFlag.length - 1];
      if (dest !== undefined) targets.push(dest);
    }
  } else if (word === 'dd') {
    const of = cmd.find((t) => t.startsWith('of='));
    if (of !== undefined) targets.push(of.slice('of='.length));
  } else if (
    word === 'sed' &&
    rest.some((t) => t === '-i' || t.startsWith('-i') || t.startsWith('--in-place'))
  ) {
    // `sed -i` edits its file operands in place. The first non-flag operand is the
    // script (`s/a/b/`) — not an absolute path, so `lexicalWriteTarget` skips it.
    for (const t of nonFlag) targets.push(t);
  }
  return targets;
}

/** The first bash WRITE target that escapes the allowed roots, or undefined —
 *  scanning redirects and write-tool destinations across every simple command, and
 *  recursing into `sh -c <script>` subshells. Best-effort and lexical: it catches
 *  the high-signal absolute/`~`/`$HOME` forms (`echo … > /abs`, `tee /abs`,
 *  `cp x /abs`, `> ~/.claude/…`) that {@link bashCdEscape} misses, while leaving
 *  benign in-cwd/relative writes and unresolvable dynamic targets to the OS sandbox
 *  (the tiered-sandbox roadmap remains the real containment boundary). */
export function bashWriteEscape(
  command: string,
  roots: readonly string[],
): string | undefined {
  for (const cmd of parseCommandLine(command)) {
    for (const token of collectBashWriteTargets(cmd)) {
      const resolved = lexicalWriteTarget(token);
      if (resolved !== undefined && isBashWriteEscape(resolved, roots)) {
        return resolved;
      }
    }
    if (cmd.length > 0 && SHELL_INTERPRETERS.has(bashBasename(cmd[0]!))) {
      const ci = cmd.findIndex((t) => t === '-c');
      const script = ci !== -1 ? cmd[ci + 1] : undefined;
      if (typeof script === 'string' && script.length > 0) {
        const nested = bashWriteEscape(script, roots);
        if (nested !== undefined) return nested;
      }
    }
  }
  return undefined;
}

/** Every raw WRITE-destination TOKEN a bash command names — redirect targets and
 *  the write-tool destinations {@link collectBashWriteTargets} recognizes (`tee`,
 *  `cp`, `mv`, `install`, `dd of=`, `sed -i`, `ln`) — across every simple command,
 *  recursing into `sh -c <script>` subshells. Returned UNRESOLVED so each caller
 *  applies its OWN resolution: {@link bashWriteEscape} resolves them
 *  absolute/`~`/`$HOME`-only (catching root ESCAPES), while the exec-sink gate
 *  resolves them RELATIVE-to-cwd (catching an in-root exec-sink write like
 *  `echo x > .github/workflows/y.yml`, which {@link bashWriteEscape} deliberately
 *  ignores because a relative target can't ESCAPE the root). This shares the one
 *  bash write-target parser so the two gates never drift. Best-effort and lexical
 *  — the same residual gaps documented at the facade head apply (dynamic `$VAR`/
 *  `$(…)` targets, non-shell interpreters, encoded commands). */
export function bashWriteTargetTokens(command: string): string[] {
  const tokens: string[] = [];
  for (const cmd of parseCommandLine(command)) {
    for (const token of collectBashWriteTargets(cmd)) {
      if (token.length > 0) tokens.push(token);
    }
    if (cmd.length > 0 && SHELL_INTERPRETERS.has(bashBasename(cmd[0]!))) {
      const ci = cmd.findIndex((t) => t === '-c');
      const script = ci !== -1 ? cmd[ci + 1] : undefined;
      if (typeof script === 'string' && script.length > 0) {
        tokens.push(...bashWriteTargetTokens(script));
      }
    }
  }
  return tokens;
}

/**
 * Resolve a raw Bash write-target TOKEN (from {@link bashWriteTargetTokens}) to an
 * absolute path INSIDE the run root, or undefined. Unlike {@link lexicalWriteTarget}
 * (absolute/`~`/`$HOME`-only, which catches root ESCAPES), a RELATIVE token is
 * resolved against `resolvedCwd` here — the in-root write shape
 * (`echo x > .git/config`, `echo x > .github/workflows/y.yml`) that escape detection
 * deliberately ignores because a relative target can't ESCAPE the root. Dynamic
 * tokens (`$VAR`, `$(…)`, backticks), fd/redirect artifacts (`&1`), and `~` home
 * targets are left alone — unresolvable lexically, or out of the repo (the escape
 * check's jurisdiction). Shared by the exec-sink gate and the git-config write-deny
 * so the two gates never drift on how a bash write target resolves.
 */
export function resolveBashWriteTargetInCwd(
  token: string,
  resolvedCwd: string,
): string | undefined {
  if (token.length === 0) return undefined;
  if (token.includes('$') || token.includes('`')) return undefined;
  if (token.startsWith('&') || token.startsWith('~')) return undefined;
  return path.isAbsolute(token)
    ? path.resolve(token)
    : path.resolve(resolvedCwd, token);
}
