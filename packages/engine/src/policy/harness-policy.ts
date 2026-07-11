/**
 * The harness runtime policy gate (hardening module #3: protected paths +
 * bypass-flag denial) — the third PreToolUse evaluator in {@link HookBus}, after
 * the destructive deny list and workspace confinement. Like both siblings it
 * fires **regardless of `permissionMode`** — including `bypassPermissions`, where
 * `canUseTool` is never consulted — so a project's declared rails hold under the
 * studio's default unattended config.
 *
 * WHY THIS EXISTS. The Structure-Lock gauntlet catches a degraded codebase AFTER
 * the agent finishes; this gate stops the highest-signal degradations AT THE TOOL
 * CALL: editing lockfiles, migrations, or generated code the project declared
 * off-limits (`protectedPaths`), Bash escape hatches that weaken the gates
 * themselves (`denyBashPatterns`, e.g. `--no-verify`), reads of declared secret
 * or injection-quarantined repo paths (`denyReadPaths` — modules #4/#12), tools
 * the project disallows outright (`disallowedTools` — module #9,
 * least-privilege), and tools the project requires an INTERACTIVE approval for
 * (`askTools` — module #9's ask tier). The rules come from the `policy` key of
 * the project's `.nightcore/harness.json` — project-authored (or Rust-written)
 * config resolved by the Rust core at dispatch and carried on `start-session`;
 * NEVER model output. (`allowTools` — module #9's allow tier — is deliberately
 * NOT enforced here: it is pure SDK-side auto-approval, unioned into
 * `Options.allowedTools` by the session options builder, and an allow must
 * never override a deny, so the hook ignores it.)
 *
 * EVALUATE ORDER. All deny tiers first — disallowedTools → protected mutation
 * paths → read denials → Bash deny patterns — then the `askTools` ask tier.
 * Deny ALWAYS wins over ask: an ask is only returned when no deny tier matched,
 * so an `askTools` entry can never shadow a deny (e.g. `Write` in `askTools`
 * still hard-denies on a protected path). The SDK aggregates multiple hooks the
 * same way (deny > ask > allow — verified in the claude 2.1.198 hook-result
 * merge), and an 'ask' decision is forwarded to the host's `canUseTool` even
 * under `bypassPermissions` (the hook pre-decision short-circuits the mode
 * pipeline's auto-allow — verified in the CLI's `createCanUseTool`).
 *
 * SELF-PROTECTION. Whenever the policy layer is armed, `.nightcore/**` is
 * IMPLICITLY protected ({@link MANIFEST_PROTECTED_PATTERN}): the manifest drives
 * both this gate and the gauntlet, so an agent must not be able to edit the
 * enforcement config that gates it (weaken checks, drop the policy) and then walk
 * through the hole. The Rust core arms the layer for ANY manifest — even one with
 * no `policy` key — precisely so this floor exists for every project with an
 * armed check. In worktree mode the real manifest sits OUTSIDE the run cwd
 * (`.nightcore/` is gitignored), where workspace confinement already denies the
 * write; this pattern closes the main-mode path (cwd = project root).
 *
 * SCOPE & LIMITS — read before extending. Protected paths cover the path-bearing
 * native mutation tools (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) with the same
 * LEXICAL resolution as workspace confinement (shared helpers; symlinks are not
 * followed). Bash write vectors (`> file`, `tee`, `sed -i`, `mv`) are NOT
 * path-checked — expressing those rails is what `denyBashPatterns` is for, and
 * real containment remains the OS sandbox (the tiered-sandbox roadmap). Path
 * matching is case-INSENSITIVE: on a case-insensitive filesystem (macOS) a
 * case-variant write lands in the protected file, so folding case only ever
 * STRENGTHENS protection (a Linux false positive blocks a legitimately distinct
 * case-variant path — rare, accepted). Bash patterns are project-authored
 * regexes matched against the RAW command line, case-sensitive (predictable for
 * pattern authors); an invalid regex is warn-and-skipped at compile so one typo
 * never bricks the layer, and a matcher this simple is heuristic, not a parser —
 * an agent can compose an evasive command (`printf`-built, base64) exactly as it
 * can against the destructive deny list.
 *
 * FAIL-OPEN/CLOSED POSTURE. A mutation-tool call whose target can't be read is
 * left alone here — workspace confinement runs FIRST in {@link HookBus} and
 * already fail-CLOSES that exact shape (deny on unreadable target), so this gate
 * never sees it un-denied in a real session; not re-implementing the denial keeps
 * one owner for that decision. Targets that resolve OUTSIDE the run cwd are also
 * left alone (confinement's jurisdiction — deny or the temp-dir allowance);
 * protected patterns are meaningful only as repo-relative paths.
 *
 * GLOB SEMANTICS (documented on the wire schema, tested here):
 *   - `*` matches within a path segment, `**` matches zero or more segments.
 *   - A pattern containing `/` is ANCHORED at the run cwd (repo root).
 *   - A pattern without `/` FLOATS: it matches its segment at any depth
 *     (`*.lock` ⇒ any lockfile anywhere, gitignore-style).
 *   - A matched PREFIX protects the whole subtree (`migrations` ⇒ every file
 *     under `migrations/`), so non-glob patterns read naturally.
 */
import * as path from 'node:path';

import type { HarnessPolicy } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import {
  BASH_TOOL,
  type ToolDenyVerdict,
} from './tool-deny-policy.js';
import {
  FILE_MUTATION_TARGET_KEY,
  isWithin,
  resolveAgainst,
  targetUnderKey,
} from './workspace-confinement.js';

/** Stable id surfaced in logs/telemetry when a protected-path rule denies. */
export const HARNESS_PROTECTED_PATH_RULE_ID = 'harness-protected-path';

/** Stable id surfaced when a project Bash deny pattern matches. */
export const HARNESS_BASH_DENY_RULE_ID = 'harness-bash-deny';

/** Stable id surfaced when a read-deny rule (module #4 secret hygiene / #12
 *  injection quarantine) refuses a native read. */
export const HARNESS_READ_DENY_RULE_ID = 'harness-read-deny';

/** Stable id surfaced when the project's `disallowedTools` list (module #9
 *  least-privilege) denies a tool outright. */
export const HARNESS_TOOL_DENY_RULE_ID = 'harness-tool-deny';

/** Stable id surfaced when the project's `askTools` list (module #9 ask tier)
 *  escalates a tool call to an interactive permission ask. */
export const HARNESS_TOOL_ASK_RULE_ID = 'harness-tool-ask';

/** Max length of one `denyBashPatterns` regex; longer patterns are
 *  warn-and-skipped at compile (same path as an invalid regex). Caps the
 *  pattern half of the catastrophic-backtracking surface: the sidecar is a
 *  single process, so one pathological `RegExp.test` stalls every session. */
export const MAX_BASH_PATTERN_LENGTH = 512;

/** Only this many chars of a Bash command are tested against the deny
 *  patterns — the input half of the backtracking mitigation. A >16 KiB command
 *  is already pathological; a deny pattern that would only match PAST the cap
 *  fails open, which is acceptable for a heuristic gate (the destructive deny
 *  list and the OS-sandbox roadmap remain the hard lines). */
export const BASH_COMMAND_SCAN_LIMIT = 16 * 1024;

/** The path-bearing native READ tools the `denyReadPaths` rules inspect → input
 *  key. `Grep`/`Glob` are covered only when they carry an explicit `path` — a
 *  rootless sweep can't be decided lexically and stays allowed (a cwd-wide Grep
 *  can still surface denied CONTENT in match lines; the full-file channel `Read`
 *  is what these rules close, and Bash-level reads (`cat .env`) are the
 *  project's `denyBashPatterns` to declare — one owner per channel). Out-of-cwd
 *  credential stores are the confinement read guard's jurisdiction, not ours:
 *  `denyReadPaths` is for paths INSIDE the repo the project declared secret
 *  (`.env*`) or quarantined (injection-flagged). */
const FILE_READ_TARGET_KEY: Record<string, string> = {
  Read: 'file_path',
  NotebookRead: 'notebook_path',
  Grep: 'path',
  Glob: 'path',
};

/** The implicit self-protection pattern — see the module header. `.nightcore/`
 *  holds the harness manifest, the task store, and future enforcement state
 *  (ratchet baselines); none of it is ever an agent's legitimate write target. */
export const MANIFEST_PROTECTED_PATTERN = '.nightcore/**';

/** One compiled protected-path rule: the original pattern (for the deny reason)
 *  plus its segment matchers (`'**'` sentinel | a per-segment regex). Exported
 *  (with {@link compilePathRule} / {@link ruleProtects}) so the exec-sink ASK gate
 *  reuses the SAME repo-relative glob engine — one home for the anchored/floating
 *  + subtree-prefix semantics both gates match against. */
export interface CompiledPathRule {
  pattern: string;
  segments: (RegExp | '**')[];
  /** True for a pattern without `/` — matched at any depth (gitignore-style). */
  floating: boolean;
}

/** One compiled Bash deny rule: the original pattern text + its regex. */
interface CompiledBashRule {
  pattern: string;
  regex: RegExp;
}

/** The compiled form {@link HookBus} holds for the session's lifetime — compile
 *  once at construction, evaluate per tool call. */
export interface CompiledHarnessPolicy {
  pathRules: readonly CompiledPathRule[];
  bashRules: readonly CompiledBashRule[];
  /** Read-denial rules (same glob semantics as `pathRules`, no implicit entry —
   *  reading the manifest is harmless; writing it is what self-protection stops). */
  readRules: readonly CompiledPathRule[];
  /** Tools denied outright for this project (exact SDK tool names). */
  disallowedTools: ReadonlySet<string>;
  /** Tools escalated to an interactive ask (exact SDK tool names). Checked only
   *  AFTER every deny tier — deny wins; see the module header. `allowTools` has
   *  no compiled form here (SDK-side auto-approval, not a hook concern). */
  askTools: ReadonlySet<string>;
}

/** The harness gate's verdict. Extends the shared deny shape so existing
 *  `denied` consumers keep working; `ask` marks module #9's ask tier — never
 *  set alongside `denied: true` (deny always wins). */
export interface HarnessPolicyVerdict extends ToolDenyVerdict {
  /** True when the call must escalate to an interactive permission ask (the
   *  hook returns `permissionDecision: 'ask'`). */
  ask?: boolean;
}

/** Escape regex metacharacters, then translate `*` → "any run of non-separator
 *  characters". Case-insensitive (see the module header). */
function segmentToRegex(segment: string): RegExp {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\*/g, '[^/\\\\]*')}$`, 'i');
}

/** Compile one protected-path pattern, or undefined for an unusable (empty)
 *  one. Leading `./`/`/` and a trailing `/` are tolerated author sugar. */
export function compilePathRule(raw: string): CompiledPathRule | undefined {
  const trimmed = raw.trim().replace(/^\.?\//, '').replace(/\/+$/, '');
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  return {
    pattern: raw,
    segments: parts.map((p) => (p === '**' ? '**' : segmentToRegex(p))),
    floating: !trimmed.includes('/'),
  };
}

/**
 * Compile the wire policy into per-session matchers. Invalid entries are
 * warn-and-skipped (one typo must never brick the layer — the valid rules still
 * enforce). The implicit self-protection pattern is ALWAYS prepended: an armed
 * policy layer protects its own manifest before anything else.
 */
export function compileHarnessPolicy(
  policy: HarnessPolicy,
  logger?: Logger,
): CompiledHarnessPolicy {
  const pathRules: CompiledPathRule[] = [];
  for (const pattern of [MANIFEST_PROTECTED_PATTERN, ...policy.protectedPaths]) {
    const rule = compilePathRule(pattern);
    if (rule === undefined) {
      logger?.warn('skipping empty harness protectedPaths pattern');
      continue;
    }
    pathRules.push(rule);
  }

  const bashRules: CompiledBashRule[] = [];
  for (const pattern of policy.denyBashPatterns) {
    // Length cap before compile: a very long project-authored pattern is the
    // easiest way to smuggle in catastrophic backtracking. Same warn-and-skip
    // posture as an invalid regex — the remaining rules still enforce.
    if (pattern.length > MAX_BASH_PATTERN_LENGTH) {
      logger?.warn('skipping oversized harness denyBashPatterns regex', {
        pattern: pattern.slice(0, 64),
        length: pattern.length,
        max: MAX_BASH_PATTERN_LENGTH,
      });
      continue;
    }
    try {
      bashRules.push({ pattern, regex: new RegExp(pattern) });
    } catch (error) {
      logger?.warn('skipping invalid harness denyBashPatterns regex', {
        pattern,
        error,
      });
    }
  }

  const readRules: CompiledPathRule[] = [];
  for (const pattern of policy.denyReadPaths) {
    const rule = compilePathRule(pattern);
    if (rule === undefined) {
      logger?.warn('skipping empty harness denyReadPaths pattern');
      continue;
    }
    readRules.push(rule);
  }

  const disallowedTools = new Set<string>();
  for (const tool of policy.disallowedTools) {
    const trimmed = tool.trim();
    if (trimmed.length === 0) {
      logger?.warn('skipping empty harness disallowedTools entry');
      continue;
    }
    disallowedTools.add(trimmed);
  }

  const askTools = new Set<string>();
  for (const tool of policy.askTools) {
    const trimmed = tool.trim();
    if (trimmed.length === 0) {
      logger?.warn('skipping empty harness askTools entry');
      continue;
    }
    // A tool in both lists denies (deny wins over ask) — warn so the author
    // learns the ask entry is dead config rather than a softer deny.
    if (disallowedTools.has(trimmed)) {
      logger?.warn('askTools entry is also in disallowedTools; deny wins', {
        tool: trimmed,
      });
    }
    askTools.add(trimmed);
  }

  return { pathRules, bashRules, readRules, disallowedTools, askTools };
}

/** True when `rule` matches a prefix of `segments` starting at `from` — a full
 *  match protects the file, a prefix match protects the subtree beneath it. */
function matchesFrom(
  rule: CompiledPathRule,
  segments: readonly string[],
  from: number,
): boolean {
  const walk = (pi: number, si: number): boolean => {
    // Pattern exhausted ⇒ the consumed prefix matched (file itself or subtree).
    if (pi === rule.segments.length) return true;
    const part = rule.segments[pi]!;
    if (part === '**') {
      // `**` matches zero or more whole segments.
      for (let k = si; k <= segments.length; k += 1) {
        if (walk(pi + 1, k)) return true;
      }
      return false;
    }
    if (si >= segments.length) return false;
    return part.test(segments[si]!) && walk(pi + 1, si + 1);
  };
  return walk(0, from);
}

/** True when `rule` protects the cwd-relative path split into `segments`. An
 *  anchored rule matches from the root only; a floating rule from any depth. */
export function ruleProtects(rule: CompiledPathRule, segments: readonly string[]): boolean {
  if (!rule.floating) return matchesFrom(rule, segments, 0);
  for (let i = 0; i < segments.length; i += 1) {
    if (matchesFrom(rule, segments, i)) return true;
  }
  return false;
}

/** The deny reason for a protected-path match — names the target AND the pattern
 *  so the model understands the rail rather than retrying variants, and points it
 *  at the honest escalation path (report to the user). */
function protectedPathReason(target: string, pattern: string): string {
  return (
    `Blocked by this project's harness policy: ${target} matches the protected ` +
    `pattern "${pattern}" and must not be modified in an autonomous run. Protected ` +
    `paths are enforcement config or machine-owned files (lockfiles, migrations, ` +
    `generated code, the .nightcore manifest). If the task genuinely requires ` +
    `changing this file, stop and report that to the user instead of working ` +
    `around the protection.`
  );
}

/** The deny reason for a Bash deny-pattern match. */
function bashDenyReason(pattern: string): string {
  return (
    `Blocked by this project's harness policy: this command matches the project's ` +
    `deny pattern "${pattern}". The project forbids this command form in autonomous ` +
    `runs (typically because it bypasses hooks, verification, or dependency ` +
    `integrity). Accomplish the task without it, or stop and report to the user.`
  );
}

/** The deny reason for a read-deny match — the target is secret material or a
 *  quarantined (injection-flagged) file the project declared off-limits. */
function readDenyReason(target: string, pattern: string): string {
  return (
    `Blocked by this project's harness policy: reading ${target} is refused — it ` +
    `matches the read-denied pattern "${pattern}". Read-denied paths hold secret ` +
    `material (.env files, keys) or content quarantined as a prompt-injection ` +
    `risk. The task must not depend on this file's contents; if it genuinely ` +
    `does, stop and report that to the user.`
  );
}

/** The deny reason when a tool is disallowed outright for this project. */
function toolDenyReason(toolName: string): string {
  return (
    `Blocked by this project's harness policy: the ${toolName} tool is disallowed ` +
    `for autonomous runs in this project (least-privilege configuration). ` +
    `Accomplish the task with the remaining tools, or stop and report to the user.`
  );
}

/** The reason carried on an ask escalation — shown as the permission prompt's
 *  context (user) and as the decision reason (agent transcript). */
function toolAskReason(toolName: string): string {
  return (
    `This project's harness policy requires interactive approval for the ` +
    `${toolName} tool (ask tier, least-privilege configuration). The call has ` +
    `been escalated to the user; wait for their decision.`
  );
}

/**
 * Evaluate a single tool call against the compiled harness policy. Returns
 * `{ denied: false }` for everything the policy doesn't cover (the common path),
 * a deny verdict for a deny-tier match, or an ask verdict (`ask: true`) when no
 * deny tier matched and the tool is in `askTools` — deny always wins, so an ask
 * entry can never shadow a deny (see the module header). `cwd` may be undefined
 * (probes/tests): path rules are then skipped — a repo-relative pattern is
 * meaningless without a root — but Bash rules and the tool tiers still enforce.
 */
export function evaluateHarnessPolicy(
  toolName: string,
  toolInput: unknown,
  policy: CompiledHarnessPolicy,
  cwd: string | undefined,
): HarnessPolicyVerdict {
  const denied = evaluateDenyTiers(toolName, toolInput, policy, cwd);
  if (denied.denied) return denied;
  if (policy.askTools.has(toolName)) {
    return {
      denied: false,
      ask: true,
      ruleId: HARNESS_TOOL_ASK_RULE_ID,
      reason: toolAskReason(toolName),
    };
  }
  return { denied: false };
}

/**
 * The deny tiers, in order: disallowedTools → protected mutation paths → read
 * denials → Bash deny patterns. Split from {@link evaluateHarnessPolicy} so the
 * ask tier provably runs only when NO deny tier matched.
 */
function evaluateDenyTiers(
  toolName: string,
  toolInput: unknown,
  policy: CompiledHarnessPolicy,
  cwd: string | undefined,
): ToolDenyVerdict {
  // Least-privilege tool denial (module #9) first: the broadest rule, needing no
  // input inspection. Belt to the SDK-Options `disallowedTools` suspenders (the
  // options builder unions the same list) — the hook holds even if the SDK-side
  // list is bypassed or regresses.
  if (policy.disallowedTools.has(toolName)) {
    return {
      denied: true,
      ruleId: HARNESS_TOOL_DENY_RULE_ID,
      reason: toolDenyReason(toolName),
    };
  }

  const key = FILE_MUTATION_TARGET_KEY[toolName];
  if (key !== undefined) {
    const denied = matchPathRules(
      toolInput,
      key,
      policy.pathRules,
      cwd,
    );
    if (denied !== undefined) {
      return {
        denied: true,
        ruleId: HARNESS_PROTECTED_PATH_RULE_ID,
        reason: protectedPathReason(denied.target, denied.pattern),
      };
    }
    return { denied: false };
  }

  // Read-denial (modules #4/#12): same lexical matching as protected paths, over
  // the path-bearing read tools. A read-shaped call is never ALSO mutation-shaped
  // (disjoint tool sets), so the two branches can't shadow each other.
  const readKey = FILE_READ_TARGET_KEY[toolName];
  if (readKey !== undefined) {
    const denied = matchPathRules(toolInput, readKey, policy.readRules, cwd);
    if (denied !== undefined) {
      return {
        denied: true,
        ruleId: HARNESS_READ_DENY_RULE_ID,
        reason: readDenyReason(denied.target, denied.pattern),
      };
    }
    return { denied: false };
  }

  if (toolName === BASH_TOOL && policy.bashRules.length > 0) {
    const command = targetUnderKey(toolInput, 'command');
    if (command === undefined) return { denied: false };
    // Input cap (the pattern cap's counterpart, see BASH_COMMAND_SCAN_LIMIT):
    // bound the text a project regex can backtrack over.
    const bounded =
      command.length > BASH_COMMAND_SCAN_LIMIT
        ? command.slice(0, BASH_COMMAND_SCAN_LIMIT)
        : command;
    for (const rule of policy.bashRules) {
      if (rule.regex.test(bounded)) {
        return {
          denied: true,
          ruleId: HARNESS_BASH_DENY_RULE_ID,
          reason: bashDenyReason(rule.pattern),
        };
      }
    }
  }

  return { denied: false };
}

/**
 * Match a tool call's path target against a compiled rule set, returning the
 * matched target+pattern or undefined. Shared by the protected-path (mutation)
 * and read-denial branches — identical resolution, identical jurisdiction:
 * - no cwd / no rules / no readable target ⇒ no match (for mutations, workspace
 *   confinement runs FIRST and fail-closes the unreadable-target shape; reads
 *   with no explicit path can't be decided lexically and stay allowed),
 * - targets resolving OUTSIDE the run cwd ⇒ no match (confinement's
 *   jurisdiction for writes, the confinement READ guard's for secret reads —
 *   these rules are meaningful only as repo-relative paths).
 */
function matchPathRules(
  toolInput: unknown,
  key: string,
  rules: readonly CompiledPathRule[],
  cwd: string | undefined,
): { target: string; pattern: string } | undefined {
  if (cwd === undefined || cwd.length === 0 || rules.length === 0) {
    return undefined;
  }
  const target = targetUnderKey(toolInput, key);
  if (target === undefined) return undefined;
  const resolvedCwd = path.resolve(cwd);
  const resolved = resolveAgainst(cwd, target);
  if (!isWithin(resolved, resolvedCwd)) return undefined;
  const rel = path.relative(resolvedCwd, resolved);
  if (rel.length === 0) return undefined;
  const segments = rel.split(/[\\/]/).filter((s) => s.length > 0);
  for (const rule of rules) {
    if (ruleProtects(rule, segments)) {
      return { target: resolved, pattern: rule.pattern };
    }
  }
  return undefined;
}
