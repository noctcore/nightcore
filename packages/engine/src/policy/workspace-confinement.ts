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
import * as path from 'node:path';

import { evaluateMcpContainment } from './confinement/mcp.js';
import {
  allowedRoots,
  confinementReason,
  isAllowedTarget,
  resolveAgainst,
  targetUnderKey,
} from './confinement/paths.js';
import {
  FILE_READ_TARGET_KEY,
  isSensitiveReadTarget,
  SENSITIVE_READ_RULE_ID,
  sensitiveReadReason,
} from './confinement/sensitive-read.js';
import {
  APPLY_PATCH_TOOL,
  bashCdEscape,
  bashWriteEscape,
  extractApplyPatchTargets,
  FILE_MUTATION_TARGET_KEY,
  WORKSPACE_CONFINEMENT_RULE_ID,
} from './confinement/workspace.js';
import { BASH_TOOL, type ToolDenyVerdict } from './tool-deny-policy.js';

// The confinement rule families now live in ./confinement/{workspace,sensitive-read,
// mcp}.ts over a shared ./confinement/paths.ts core. This module remains the FACADE:
// it owns the orchestrator + the whole-gate documentation above, and re-exports the
// public surface (the rule ids for telemetry/tests; the path-resolution + mutation-
// key helpers the harness-policy gate reuses) so every consumer keeps one import site.
export { MCP_CONTAINMENT_RULE_ID } from './confinement/mcp.js';
export {
  allowedRoots,
  confinementReason,
  isAllowedTarget,
  isWithin,
  resolveAgainst,
  targetUnderKey,
} from './confinement/paths.js';
export { SENSITIVE_READ_RULE_ID } from './confinement/sensitive-read.js';
export {
  APPLY_PATCH_TOOL,
  bashWriteTargetTokens,
  extractApplyPatchTargets,
  FILE_MUTATION_TARGET_KEY,
  WORKSPACE_CONFINEMENT_RULE_ID,
} from './confinement/workspace.js';

/**
 * Evaluate a single tool call against the workspace-confinement gate. Returns
 * `{ denied: false }` for anything it doesn't cover (the common path) so the
 * caller falls through to its normal allow. An empty `cwd` disables the gate
 * (nothing to confine to) — byte-identical to the pre-feature behavior. Dispatches
 * to the rule families in ./confinement in the same order the branches always ran.
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
