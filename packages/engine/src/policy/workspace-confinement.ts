/**
 * Confine a session's file mutations to its working directory (the run cwd),
 * enforced through the SDK `PreToolUse` hook (see {@link HookBus}). Like the
 * destructive deny policy, the hook fires **regardless of `permissionMode`** —
 * including `bypassPermissions`, where `canUseTool` is never consulted — so this
 * gate holds under the studio's default unattended config.
 *
 * WHY THIS EXISTS. Nightcore runs a worktree-mode task with `cwd` set to the
 * task's worktree (`<repo>/.nightcore/worktrees/<taskId>`). Because that worktree
 * is nested INSIDE the main checkout, an agent can trivially resolve "up" to the
 * main repo root and — under bypass — write there, silently corrupting the main
 * branch while the worktree stays empty (observed 2026-07-01: a worktree task
 * edited `<repo>/apps/web/...` on `main`; the worktree branch stayed empty and the
 * reviewer, correctly reading the worktree, returned FAIL). This gate refuses any
 * file-mutating tool call whose target resolves OUTSIDE the run cwd, so worktree
 * isolation holds even when the model uses an absolute path to the parent.
 *
 * SCOPE & LIMITS — read before extending. EXACT for the path-bearing native
 * mutation tools (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`): absolute-path
 * escapes, `..` traversal, and the `/repo` vs `/repo-evil` prefix trick are all
 * caught (lexical `path.resolve` + a trailing-separator-guarded prefix check). A
 * known mutation tool whose target path can't be read is DENIED (fail-closed — a
 * containment gate must not fail open on SDK shape drift). `ApplyPatch` is covered
 * the same way but via a multi-target parse of its patch body (see
 * {@link APPLY_PATCH_TOOL}): every Add/Update/Delete/Move target is confined, and a
 * patch that exposes NO inspectable target is DENIED (fail-closed). For `Bash` it is
 * BEST-EFFORT and LEXICAL: an absolute `cd`/`pushd` outside cwd, AND an absolute-
 * (or `~`/`$HOME`-) path write via a redirect (`> /abs`, `2>/abs`, `>> ~/…`),
 * `tee`/`cp`/`mv`/`install`/`dd of=`/`sed -i`/`ln`, or a `sh -c` subshell of those,
 * are flagged — which closes the marquee `> ~/.claude/settings.json` config-
 * poisoning vector. It is NOT a sandbox — real containment is the OS sandbox (the
 * tiered-sandbox roadmap). Known residual gaps:
 *  - Bash write vectors we can't resolve lexically: a RELATIVE target (`> ../x`,
 *    `cd ..` then a relative write) or a DYNAMIC one (`> $VAR/x`, `> $(…)`), and a
 *    write through a non-shell interpreter (`python -c "open(...,'w')"`) can still
 *    escape. `/dev/*` sinks are intentionally allowed (`2>/dev/null`).
 *  - MCP write/network tools (`mcp__<server>__write_file`, `…__http_post`, …) are
 *    not native tool names, so the native-name gates miss them. They are caught by
 *    a NAME-HEURISTIC fallback (see {@link evaluateMcpContainment}): a write-classed
 *    action is confined by its path argument (denied outside cwd, denied fail-closed
 *    when it exposes no inspectable path), and a network-classed action is denied
 *    outright (egress can't be contained by a path check) — under bypass, where the
 *    `dangerous`→prompt classification is inert. This is a coarse keyword classifier,
 *    not a capability model: an unconventionally named write/egress tool, or a write
 *    via a non-path argument, can still slip. Real containment is the OS sandbox.
 *  - Symlinks: resolution is LEXICAL (not `realpath`, because a `Write` target
 *    need not exist yet), so a symlink inside cwd pointing outward is not
 *    followed — reachable in two steps under bypass (`Bash: ln -s /repo esc`, then
 *    `Write esc/…`).
 *  - Case-insensitive filesystems (macOS/Windows): the prefix check is
 *    case-SENSITIVE, so a case-variant of the cwd path is a FALSE POSITIVE (blocks
 *    a legitimate in-cwd write); it never widens containment.
 *  - Subagent-issued mutations rely on the SDK firing this session's PreToolUse
 *    hook for subagent tool calls (believed true; see {@link HookBus}).
 * The OS temp dir is allowed so scratch writes keep working — EXCEPT when the run
 * cwd is itself under the temp dir (a dogfood scratch repo, or a clone in /tmp),
 * where the temp allowance would swallow the whole repo; there it is dropped and
 * confinement stays strict to cwd. The whole gate rests on the SDK invoking
 * PreToolUse under `bypassPermissions` (the same assumption the destructive deny
 * policy makes) — keep that covered by a dogfood/integration assertion.
 *
 * READ GUARD — secret exfiltration, NOT blanket read confinement. The finding
 * this gate answers pairs "no read-confinement" with "no egress control": under
 * bypass a prompt-injected task can `Read ~/.aws/credentials` / `~/.claude.json` /
 * another project's `.env` and ship it out. The egress half is closed elsewhere
 * (the Bash `network-exfiltration` deny rule + `WebFetch`/`WebSearch` denied by
 * kind preset for every non-`research` kind). This gate closes the highest-value
 * READ: it refuses a `Read` tool call whose resolved target is a known credential
 * store (`~/.aws`, `~/.ssh`, `~/.gnupg`, `~/.azure`, `~/.kube`, gcloud/gh config,
 * `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`,
 * `~/.claude.json`, …) OR a portable secret file (`.env`/`.env.<env>` — but not an
 * `.env.example`/`.sample`/`.template` — or an SSH private key `id_rsa`/`id_ed25519`
 * …) that sits OUTSIDE the run roots (so the task's OWN in-cwd `.env` still reads).
 *
 * WHY A TARGETED DENYLIST, NOT "confine Read to cwd + roots" (a deliberate,
 * documented decision — do not silently "fix" it to a blanket allowlist). Blanket
 * cwd-confinement of reads has an unacceptable false-positive rate for a coding
 * agent: in worktree mode the run cwd is `<repo>/.nightcore/worktrees/<id>` while
 * the hoisted `node_modules` lives at the MAIN repo root (outside cwd), and agents
 * legitimately read toolchain/system files and sibling packages — a strict
 * allowlist would block all of that. So we allow-by-default and deny only the
 * known secret targets, which kills the exact exfil path the finding names with
 * near-zero collateral. This is defense-in-depth, not a sandbox — a determined
 * read via `Bash` (`cat ~/.aws/credentials`), `Grep`, an MCP reader, a symlink
 * (resolution is LEXICAL here, as on the mutation side), or a secret store not on
 * the list is NOT caught; the real boundary is the OS sandbox, and the primary
 * containment is that the egress channels above are already shut. Full read
 * confinement is deferred to that OS sandbox (the tiered-sandbox roadmap).
 */
import * as os from 'node:os';
import * as path from 'node:path';

import { BASH_TOOL, parseCommandLine, type ToolDenyVerdict } from './tool-deny-policy.js';

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

/** Stable id surfaced in logs/telemetry when the confinement gate denies. */
export const WORKSPACE_CONFINEMENT_RULE_ID = 'workspace-confinement';

/** Stable id surfaced when the READ guard refuses a credential/secret read (kept
 *  distinct from `workspace-confinement` so telemetry can tell "escaped a write"
 *  apart from "tried to read a secret"). */
export const SENSITIVE_READ_RULE_ID = 'sensitive-read';

/** Stable id surfaced when the MCP fallback refuses an uncontained mutation or a
 *  network egress by an external `mcp__*` tool (distinct from the native-tool
 *  `workspace-confinement` id so telemetry can tell the two apart). */
export const MCP_CONTAINMENT_RULE_ID = 'mcp-uncontained';

/** The native read tool whose target path the read guard inspects → its input
 *  key. Only `Read` is covered; `Grep`/`Glob`/`Bash`-based reads are out of scope
 *  (see the module header). */
const FILE_READ_TARGET_KEY: Record<string, 'file_path'> = { Read: 'file_path' };

/** The reason the agent sees on denial — names the working dir AND the offending
 *  target so the model can adapt (retry with a path inside the working dir). */
function confinementReason(target: string, cwd: string): string {
  return (
    `Blocked by Nightcore worktree isolation: this task's working directory is ${cwd}, ` +
    `but the tool targets ${target}, which is OUTSIDE it. Operate only inside the working ` +
    `directory (relative paths are resolved against it). Writing outside it would corrupt ` +
    `another checkout of the repository.`
  );
}

/** The reason the agent sees when the READ guard refuses a secret read — names the
 *  target and the working dir so the model understands it must stay in-cwd. */
function sensitiveReadReason(target: string, cwd: string): string {
  return (
    `Blocked by Nightcore secret-exfiltration guard: reading ${target} is refused ` +
    `because it is a credential/secret store outside this task's working directory ` +
    `(${cwd}). Read only files inside the working directory; SSH/cloud keys, registry ` +
    `tokens, and other projects' .env files are off-limits so a compromised task ` +
    `cannot exfiltrate them.`
  );
}

/** Lexically resolve `p` against `cwd` (an absolute `p` stands alone). No fs
 *  access, so a not-yet-created `Write` target still resolves. Exported for the
 *  harness-policy gate (same resolution, same limits — lexical, not realpath). */
export function resolveAgainst(cwd: string, p: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
}

/** True when `child` is `parent` itself or nested beneath it. Both are resolved
 *  absolute; the trailing-separator guard stops `/repo-evil` matching `/repo`.
 *  Exported for the harness-policy gate. */
export function isWithin(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * The roots a write may legitimately land in: always the run cwd, PLUS the OS
 * temp dir for scratch files — but the temp allowance is DROPPED when the run cwd
 * is itself under the temp dir. Otherwise a checkout hosted under temp (the
 * dogfood scratch repo, or a clone in /tmp) would have its whole tree swallowed by
 * the temp allowance and confinement would silently fail open. Takes the already
 * resolved cwd so callers don't re-resolve.
 */
function allowedRoots(resolvedCwd: string): readonly string[] {
  const tmp = path.resolve(os.tmpdir());
  return isWithin(resolvedCwd, tmp) ? [resolvedCwd] : [resolvedCwd, tmp];
}

/** True when `resolved` is within any allowed root. */
function isAllowedTarget(resolved: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(resolved, root));
}

/** Extract the string target held under `key` in a tool's input, or undefined
 *  when absent / not a non-empty string. Exported for the harness-policy gate. */
export function targetUnderKey(toolInput: unknown, key: string): string | undefined {
  if (toolInput === null || typeof toolInput !== 'object') return undefined;
  const value = (toolInput as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The user's home directory, resolved once. Empty when it can't be determined —
 *  the home-relative credential-store checks are then skipped (the filename-pattern
 *  checks, which don't need home, still apply). */
const HOME_DIR: string = ((): string => {
  try {
    const home = os.homedir();
    return home.length > 0 ? path.resolve(home) : '';
  } catch {
    return '';
  }
})();

/** Home-relative credential stores a task must never read (dirs match their whole
 *  subtree; files match exactly). These hold the portable, high-value secrets a
 *  prompt-injected task would exfiltrate — cloud/SSH keys, registry tokens, the
 *  Claude credential file. */
const SENSITIVE_HOME_RELATIVE: readonly string[] = [
  '.aws',
  '.ssh',
  '.gnupg',
  '.azure',
  '.kube',
  '.config/gcloud',
  '.config/gh',
  '.docker/config.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.claude.json',
  '.claude/.credentials.json',
] as const;

/** SSH/host private-key basenames — secrets regardless of directory, so they are
 *  matched by filename anywhere outside the run roots (a key copied into a repo, a
 *  sibling project's key, etc.). Public `.pub` counterparts are NOT secret. */
const PRIVATE_KEY_BASENAMES: ReadonlySet<string> = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

/** `.env.<suffix>` suffixes that denote a NON-secret template checked into VCS —
 *  reading these is always fine, so they are excluded from the `.env` secret match. */
const ENV_TEMPLATE_SUFFIXES: ReadonlySet<string> = new Set([
  'example',
  'sample',
  'template',
  'dist',
  'defaults',
]);

/** True for a dotenv secret filename: `.env` or `.env.<env>` (e.g. `.env.local`,
 *  `.env.production`), EXCLUDING the non-secret templates (`.env.example`, …). */
function isDotEnvSecret(base: string): boolean {
  if (base === '.env') return true;
  if (!base.startsWith('.env.')) return false;
  return !ENV_TEMPLATE_SUFFIXES.has(base.slice('.env.'.length));
}

/** True when a resolved read target is a known credential store or a portable
 *  secret file — the READ guard's denylist. Callers apply this ONLY to targets
 *  already known to sit outside the run roots (so an in-cwd `.env` still reads). */
function isSensitiveReadTarget(resolved: string): boolean {
  if (
    HOME_DIR.length > 0 &&
    SENSITIVE_HOME_RELATIVE.some((rel) => isWithin(resolved, path.join(HOME_DIR, rel)))
  ) {
    return true;
  }
  const base = path.basename(resolved);
  return isDotEnvSecret(base) || PRIVATE_KEY_BASENAMES.has(base);
}

/** The first ABSOLUTE `cd`/`pushd` target in a bash line that escapes the allowed
 *  roots, or undefined. Best-effort and NARROW by design: a relative `cd` is out
 *  of scope (a relative `cd ..` CAN escape, but Bash writes are unconfined anyway
 *  — see the header), and a dynamic target (`$(…)`, `~`) can't be resolved
 *  lexically — so both are left alone. This only catches the high-signal
 *  `cd /absolute/outside` form (the exact vector observed in the reported bug). */
function bashCdEscape(toolInput: unknown, roots: readonly string[]): string | undefined {
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
function bashWriteEscape(
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

/** The action segment of an `mcp__<server>__<action>` tool name (everything after
 *  the final `__`), lowercased. Keying off the ACTION — not the whole name —
 *  avoids classifying a tool by its SERVER name (`mcp__http_server__list_files`
 *  is a list, not a network call). */
function mcpAction(toolName: string): string {
  const idx = toolName.lastIndexOf('__');
  return (idx === -1 ? toolName : toolName.slice(idx + 2)).toLowerCase();
}

/** Action-name substrings that denote a NETWORK/egress capability — a channel
 *  that could ship local data off the machine. Egress can't be contained by a
 *  path check, so a match is denied outright under bypass (fail-closed). */
const MCP_NETWORK_KEYWORDS: readonly string[] = [
  'http',
  'fetch',
  'request',
  'curl',
  'wget',
  'url',
  'uri',
  'webhook',
  'upload',
  'download',
  'browse',
  'navigate',
  'socket',
  'email',
  'mail',
  'send',
  'publish',
  'post',
];

/** Action-name substrings that denote a file-WRITE capability — contained by its
 *  path argument (allowed inside cwd, denied outside; denied fail-closed when no
 *  path argument can be found, since an uncontained mutation can't be verified). */
const MCP_WRITE_KEYWORDS: readonly string[] = [
  'write',
  'create',
  'edit',
  'save',
  'put',
  'append',
  'delete',
  'remove',
  'move',
  'rename',
  'copy',
  'mkdir',
  'patch',
  'update',
  'insert',
  'replace',
  'touch',
  'chmod',
];

/** Classify an external MCP tool by its action name. `network` and `write` are the
 *  two uncontained-by-default capabilities the native-name gates never see; every
 *  other action (reads, queries, listings, unknown-benign) is left to fall
 *  through. Network is checked first so a `put_url`/`upload` reads as egress. */
function classifyMcpTool(toolName: string): 'network' | 'write' | 'other' {
  const action = mcpAction(toolName);
  if (MCP_NETWORK_KEYWORDS.some((k) => action.includes(k))) return 'network';
  if (MCP_WRITE_KEYWORDS.some((k) => action.includes(k))) return 'write';
  return 'other';
}

/** Input keys that conventionally carry a filesystem destination. */
const MCP_PATH_KEYS: ReadonlySet<string> = new Set([
  'path',
  'file_path',
  'filepath',
  'file',
  'target',
  'dest',
  'destination',
  'output',
  'out',
  'filename',
  'to',
  'location',
  'dir',
  'directory',
]);

/** Best-effort extraction of filesystem-path arguments from an unknown MCP tool
 *  input: a string value under a conventional path key, or any string that looks
 *  like a local path (absolute / `./` / `../` / `~`). URL-scheme strings
 *  (`https://…`) are excluded — they are not filesystem targets. */
function extractMcpPaths(toolInput: unknown): string[] {
  if (toolInput === null || typeof toolInput !== 'object') return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(toolInput as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue; // a URL, not a path
    const looksLikePath =
      MCP_PATH_KEYS.has(key.toLowerCase()) ||
      path.isAbsolute(value) ||
      value.startsWith('./') ||
      value.startsWith('../') ||
      value.startsWith('~');
    if (looksLikePath) paths.push(value);
  }
  return paths;
}

/** The reason surfaced when the MCP fallback refuses a network/uncontained-write
 *  external tool call under bypass (no `canUseTool` prompt fires there). */
function mcpContainmentReason(toolName: string, cwd: string, detail: string): string {
  return (
    `Blocked by Nightcore MCP containment: the external tool ${toolName} ${detail}, ` +
    `so it is refused under the studio's unattended (bypass) mode where no approval ` +
    `prompt fires. This task's working directory is ${cwd}; run this server's ` +
    `write/network tools in an attended session, or scope the write to a path inside ` +
    `the working directory.`
  );
}

/**
 * The bypass-mode fallback for external `mcp__*` tools, which the native-name
 * gates above never inspect: a write-capable MCP tool is confined by its path
 * argument (denied outside cwd, denied fail-closed when no path is present — an
 * uncontained mutation can't be verified), and a network-capable one is denied
 * outright (egress can't be contained by a path check). Read/query/unknown-benign
 * actions fall through to allow, matching how native unknown reads are left alone.
 */
function evaluateMcpContainment(
  toolName: string,
  toolInput: unknown,
  resolvedCwd: string,
  roots: readonly string[],
): ToolDenyVerdict {
  const kind = classifyMcpTool(toolName);
  if (kind === 'network') {
    return {
      denied: true,
      ruleId: MCP_CONTAINMENT_RULE_ID,
      reason: mcpContainmentReason(
        toolName,
        resolvedCwd,
        'looks like a network/egress tool that could exfiltrate local data',
      ),
    };
  }
  if (kind === 'write') {
    const paths = extractMcpPaths(toolInput);
    if (paths.length === 0) {
      return {
        denied: true,
        ruleId: MCP_CONTAINMENT_RULE_ID,
        reason: mcpContainmentReason(
          toolName,
          resolvedCwd,
          'looks like a file-mutating tool but exposes no inspectable path argument',
        ),
      };
    }
    for (const p of paths) {
      const resolved = resolveAgainst(resolvedCwd, p);
      if (!isAllowedTarget(resolved, roots)) {
        return {
          denied: true,
          ruleId: WORKSPACE_CONFINEMENT_RULE_ID,
          reason: confinementReason(resolved, resolvedCwd),
        };
      }
    }
  }
  return { denied: false };
}

/**
 * Evaluate a single tool call against the workspace-confinement gate. Returns
 * `{ denied: false }` for anything it doesn't cover (the common path) so the
 * caller falls through to its normal allow. An empty `cwd` disables the gate
 * (nothing to confine to) — byte-identical to the pre-feature behavior.
 */
export function evaluateWorkspaceConfinement(
  toolName: string,
  toolInput: unknown,
  cwd: string,
): ToolDenyVerdict {
  if (cwd.length === 0) return { denied: false };
  const resolvedCwd = path.resolve(cwd);
  const roots = allowedRoots(resolvedCwd);

  // `ApplyPatch` names its targets in a patch body (possibly MANY files), not in a
  // single key, so confine every parsed target and FAIL-CLOSED when the patch
  // exposes none (an uncontained mutation can't be verified — mirrors the MCP
  // uncontained-write branch). Runs before the single-key mutation branch below so
  // the multi-target parse owns `ApplyPatch`.
  if (toolName === APPLY_PATCH_TOOL) {
    const targets = extractApplyPatchTargets(toolInput);
    if (targets.length === 0) {
      return {
        denied: true,
        ruleId: WORKSPACE_CONFINEMENT_RULE_ID,
        reason:
          `Blocked by Nightcore worktree isolation: could not read the target path(s) ` +
          `of this ApplyPatch call, so it is refused to protect the working directory ` +
          `(${resolvedCwd}). Patch files only inside the working directory.`,
      };
    }
    for (const target of targets) {
      const resolved = resolveAgainst(cwd, target);
      if (!isAllowedTarget(resolved, roots)) {
        return {
          denied: true,
          ruleId: WORKSPACE_CONFINEMENT_RULE_ID,
          reason: confinementReason(resolved, resolvedCwd),
        };
      }
    }
    return { denied: false };
  }

  // A known native mutation tool → confine its target. FAIL-CLOSED: if the tool is
  // one we confine but its target path can't be read (SDK shape drift, a malformed
  // call), DENY rather than silently allow — a containment gate must not fail open.
  const key = FILE_MUTATION_TARGET_KEY[toolName];
  if (key !== undefined) {
    const target = targetUnderKey(toolInput, key);
    if (target === undefined) {
      return {
        denied: true,
        ruleId: WORKSPACE_CONFINEMENT_RULE_ID,
        reason:
          `Blocked by Nightcore worktree isolation: could not read the target path of ` +
          `this ${toolName} call, so it is refused to protect the working directory ` +
          `(${resolvedCwd}). Provide an explicit file path inside the working directory.`,
      };
    }
    const resolved = resolveAgainst(cwd, target);
    if (!isAllowedTarget(resolved, roots)) {
      return {
        denied: true,
        ruleId: WORKSPACE_CONFINEMENT_RULE_ID,
        reason: confinementReason(resolved, resolvedCwd),
      };
    }
    return { denied: false };
  }

  // A read tool → refuse only a KNOWN credential/secret target outside the run
  // roots (a targeted denylist, NOT blanket read confinement — see the header).
  // FAIL-OPEN by design: an unreadable/absent target degrades to today's behavior
  // (allow), since the guard only ever denies targets it positively recognizes as
  // secret. The task's own in-cwd files (incl. its `.env`) are allowed first.
  const readKey = FILE_READ_TARGET_KEY[toolName];
  if (readKey !== undefined) {
    const target = targetUnderKey(toolInput, readKey);
    if (target === undefined) return { denied: false };
    const resolved = resolveAgainst(cwd, target);
    if (isAllowedTarget(resolved, roots)) return { denied: false };
    if (isSensitiveReadTarget(resolved)) {
      return {
        denied: true,
        ruleId: SENSITIVE_READ_RULE_ID,
        reason: sensitiveReadReason(resolved, resolvedCwd),
      };
    }
    return { denied: false };
  }

  if (toolName === BASH_TOOL) {
    const command = targetUnderKey(toolInput, 'command');
    const escape =
      bashCdEscape(toolInput, roots) ??
      (command !== undefined ? bashWriteEscape(command, roots) : undefined);
    if (escape !== undefined) {
      return {
        denied: true,
        ruleId: WORKSPACE_CONFINEMENT_RULE_ID,
        reason: confinementReason(escape, resolvedCwd),
      };
    }
  }

  // External `mcp__*` tools — the one tool class both native-name gates miss. Under
  // bypass, `canUseTool` (which classifies unknown MCP as dangerous) never fires,
  // so contain write/network MCP tools here (fail-closed for uncontained mutation).
  if (toolName.startsWith('mcp__')) {
    return evaluateMcpContainment(toolName, toolInput, resolvedCwd, roots);
  }

  return { denied: false };
}
