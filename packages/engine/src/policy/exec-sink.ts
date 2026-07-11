/**
 * The execution-sink write-protection gate — the FOURTH PreToolUse evaluator in
 * {@link HookBus}, after the destructive deny list, workspace confinement, and the
 * project's harness policy. Like every sibling it fires **regardless of
 * `permissionMode`** — including `bypassPermissions`, where `canUseTool` is never
 * consulted — so it holds under the studio's DEFAULT unattended config
 * (`permission_mode: "bypass"`, `sandbox_sessions: false`, `default_run_mode:
 * "main"`), which is the whole point.
 *
 * WHY THIS EXISTS (issue #142). Under those defaults an agent can write a file
 * that changes HOW CODE EXECUTES straight into the repo cwd — a
 * `.github/workflows/*.yml` that runs in CI on the next push, a `.claude/hooks`
 * or `settings.local.json` that executes on the next session, a `package.json`
 * `scripts` entry that runs on install, a git/husky hook. Each is a ONE-SHOT
 * remote-code-execution vector. The existing gates do not stop it: workspace
 * confinement ALLOWS it (the target is inside cwd), the harness policy is EMPTY by
 * default (no manifest), and the opt-in macOS Seatbelt sandbox leaves cwd fully
 * writable. So this gate escalates every write to a known execution sink to an
 * interactive ASK — a decision that provably holds even under `bypassPermissions`
 * (the SDK forwards a hook 'ask' to the host's `canUseTool`, short-circuiting the
 * mode pipeline's auto-allow — verified against the shipped CLI). A legitimate
 * task that edits CI or `package.json` proceeds after ONE approval; a
 * prompt-injected one is stopped at the tool call. This is deliberately ASK, not
 * deny: these are files agents sometimes legitimately touch, so a hard deny would
 * be a constant false-positive — the review gate is the right severity.
 *
 * PRECEDENCE (see {@link HookBus}). Runs LAST, so:
 *  - A hard DENY still wins — the destructive deny list, workspace confinement,
 *    and a project `protectedPaths` entry all run first and return before this
 *    gate. In particular an exec-sink write that ALSO escapes the run cwd is
 *    DENIED by confinement and never reaches here, so this gate can never
 *    downgrade a deny to an ask. It only ever matches targets INSIDE the run cwd.
 *  - The per-project `allowExecSinks` list DOWNGRADES a matched sink to a silent
 *    allow (a repo whose agents legitimately manage CI), but softens ONLY this
 *    ask — it can never override any deny above.
 *
 * SCOPE & LIMITS. Covers the path-bearing native mutation tools
 * (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`), the multi-target `ApplyPatch` body,
 * and the Bash write vector (`>`/`>>` redirects, `tee`/`cp`/`mv`/`install`/`dd
 * of=`/`sed -i`/`ln`, and `sh -c` subshells) via the SAME lexical write-target
 * parser workspace confinement uses ({@link bashWriteTargetTokens}) — resolved
 * RELATIVE to cwd here (confinement resolves absolute-only, to catch escapes; an
 * exec-sink write is typically a RELATIVE in-cwd path). Best-effort and lexical,
 * matching confinement's posture: a DYNAMIC Bash target (`> $VAR/x`, `> $(…)`), a
 * write through a non-shell interpreter (`python -c "open(...,'w')"`), or an
 * encoded command can still slip — real containment is the OS sandbox (the
 * tiered-sandbox roadmap). The set is a FIXED, built-in denylist (never model
 * output), auditable in one place ({@link EXEC_SINK_PATTERNS}); it uses the SAME
 * repo-relative glob engine as the harness policy ({@link compilePathRule} /
 * {@link ruleProtects}), so anchored/floating semantics match everywhere.
 */
import * as path from 'node:path';

import {
  type CompiledPathRule,
  compilePathRule,
  type HarnessPolicyVerdict,
  ruleProtects,
} from './harness-policy.js';
import { BASH_TOOL } from './tool-deny-policy.js';
import {
  APPLY_PATCH_TOOL,
  bashWriteTargetTokens,
  extractApplyPatchTargets,
  FILE_MUTATION_TARGET_KEY,
  isWithin,
  resolveAgainst,
  resolveBashWriteTargetInCwd,
  targetUnderKey,
} from './workspace-confinement.js';

/** Stable id surfaced in logs/telemetry (and the flight recorder) when the
 *  exec-sink gate escalates a write to an interactive approval. */
export const EXEC_SINK_ASK_RULE_ID = 'exec-sink-ask';

/**
 * The built-in execution-sink denylist: repo-relative paths/globs whose CONTENTS
 * decide how code runs, so a write to one is escalated to an interactive ask.
 * Glob semantics are the harness policy's (see `HarnessPolicySchema`): `**`
 * matches zero-or-more segments, a pattern WITH `/` is anchored at the run root,
 * a pattern WITHOUT `/` floats at any depth. This is the single, auditable source
 * — add a sink here and every write tool (native + Bash) picks it up.
 *
 * Generalized from the Harness artifact-writer's execution-sink denylist
 * (`sidecar/harness/apply.rs`), which guarded only Harness-authored writes; this
 * brings the same concept to the general agent PreToolUse gate.
 */
export const EXEC_SINK_PATTERNS: readonly string[] = [
  // --- CI/CD: runs in CI on the next push/PR (anchored — GitHub only reads the
  //     repo-ROOT .github, so a nested copy is not an execution sink). ---
  '.github/workflows/**', // workflow YAML executed by GitHub Actions
  '.github/actions/**', // composite/local actions the workflows invoke
  // --- Agent + git execution hooks: run on the next session / on commit-push-
  //     checkout (anchored at the repo root, where the runtime discovers them). ---
  '.claude/**', // settings(.local).json, hooks/, skills/, agents/, commands/, plugins/
  '.git/hooks/**', // git hook scripts (pre-commit, pre-push, …)
  '.husky/**', // husky-managed git hooks
  // --- Package + shell env that auto-execute (FLOATING — a workspace package's
  //     manifest runs scripts too, and direnv/mise eval per-directory, so a
  //     nested copy is just as much a sink as the root one). ---
  'package.json', // the `scripts` field (postinstall/prepare/run …) is the RCE vector
  '.envrc', // direnv: eval'd on `cd` into the directory
  '.mise.toml', // mise: tasks/env eval'd on `cd` into the directory
];

/** The compiled form {@link HookBus} holds for the session's lifetime — the
 *  built-in sink rules plus the project's `allowExecSinks` downgrade rules,
 *  compiled once at construction and evaluated per tool call. */
export interface CompiledExecSinkGate {
  /** The built-in {@link EXEC_SINK_PATTERNS}, compiled. */
  sinkRules: readonly CompiledPathRule[];
  /** The project's `HarnessPolicy.allowExecSinks` patterns, compiled. A target
   *  that matches a sink AND an allowance is downgraded to a silent allow. */
  allowRules: readonly CompiledPathRule[];
}

/** Compile the built-in sink set plus the project's `allowExecSinks` downgrade
 *  list. Empty/invalid allowance patterns are skipped (they only ever WIDEN the
 *  ask surface back toward protection, so a typo fails safe). */
export function compileExecSinkGate(
  allowExecSinks: readonly string[] = [],
): CompiledExecSinkGate {
  const sinkRules = EXEC_SINK_PATTERNS.map(compilePathRule).filter(
    (rule): rule is CompiledPathRule => rule !== undefined,
  );
  const allowRules: CompiledPathRule[] = [];
  for (const pattern of allowExecSinks) {
    const rule = compilePathRule(pattern);
    if (rule !== undefined) allowRules.push(rule);
  }
  return { sinkRules, allowRules };
}

/** The first sink pattern that matches `segments`, or undefined. */
function matchedSink(
  rules: readonly CompiledPathRule[],
  segments: readonly string[],
): string | undefined {
  for (const rule of rules) {
    if (ruleProtects(rule, segments)) return rule.pattern;
  }
  return undefined;
}

/** True when any rule matches `segments` (used for the allowance downgrade). */
function anyMatches(
  rules: readonly CompiledPathRule[],
  segments: readonly string[],
): boolean {
  return rules.some((rule) => ruleProtects(rule, segments));
}

/** The approval prompt (user) + decision reason (agent transcript) for a matched
 *  exec-sink write — names the file, the reason, and the honest escalation path. */
function execSinkAskReason(target: string, pattern: string): string {
  return (
    `Writing to ${target} can change how code executes — it matches the ` +
    `execution-sink "${pattern}" (CI workflows, git/husky hooks, Claude config, ` +
    `or package scripts). Nightcore holds these writes for your approval because ` +
    `a single one is a one-shot code-execution vector, even in an autonomous run. ` +
    `Approve if this change is expected; otherwise reject. A project can ` +
    `pre-approve specific sinks via the harness policy's allowExecSinks list.`
  );
}

/** Every filesystem target a single tool call would WRITE, resolved to an
 *  absolute path against `cwd` — the native mutation tools' single target, every
 *  `ApplyPatch` body target, and the Bash write-vector tokens. Bash reuses the
 *  shared confinement parser so the two gates never drift. */
function resolvedWriteTargets(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  resolvedCwd: string,
): string[] {
  if (toolName === APPLY_PATCH_TOOL) {
    return extractApplyPatchTargets(toolInput).map((t) => resolveAgainst(cwd, t));
  }
  const key = FILE_MUTATION_TARGET_KEY[toolName];
  if (key !== undefined) {
    const target = targetUnderKey(toolInput, key);
    return target !== undefined ? [resolveAgainst(cwd, target)] : [];
  }
  if (toolName === BASH_TOOL) {
    const command = targetUnderKey(toolInput, 'command');
    if (command === undefined) return [];
    const targets: string[] = [];
    for (const token of bashWriteTargetTokens(command)) {
      const resolved = resolveBashWriteTargetInCwd(token, resolvedCwd);
      if (resolved !== undefined) targets.push(resolved);
    }
    return targets;
  }
  return [];
}

/**
 * Evaluate a single tool call against the exec-sink gate. Returns `{ denied:
 * false }` (no opinion) for anything it doesn't cover — the common path — or an
 * ask verdict (`ask: true`, never `denied: true`) when a WRITE targets a built-in
 * execution sink INSIDE the run cwd that the project hasn't downgraded via
 * `allowExecSinks`. An empty `cwd` disables the gate (a repo-relative sink is
 * meaningless without a root). Never denies: a hard deny is an earlier gate's
 * job, and this gate must never downgrade one (it only inspects in-cwd targets,
 * and it runs after every deny tier).
 */
export function evaluateExecSinkGate(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  gate: CompiledExecSinkGate,
): HarnessPolicyVerdict {
  if (cwd.length === 0 || gate.sinkRules.length === 0) return { denied: false };
  const resolvedCwd = path.resolve(cwd);

  for (const resolved of resolvedWriteTargets(toolName, toolInput, cwd, resolvedCwd)) {
    // Only in-cwd targets are exec-sink candidates: an out-of-cwd write is
    // workspace confinement's jurisdiction (denied there, before this gate), so
    // this gate can never downgrade a confinement deny to an ask.
    if (!isWithin(resolved, resolvedCwd)) continue;
    const rel = path.relative(resolvedCwd, resolved);
    if (rel.length === 0) continue;
    const segments = rel.split(/[\\/]/).filter((s) => s.length > 0);
    const sink = matchedSink(gate.sinkRules, segments);
    if (sink === undefined) continue;
    // Per-project downgrade: this repo declared this sink agent-writable.
    if (anyMatches(gate.allowRules, segments)) continue;
    return {
      denied: false,
      ask: true,
      ruleId: EXEC_SINK_ASK_RULE_ID,
      reason: execSinkAskReason(resolved, sink),
    };
  }
  return { denied: false };
}
