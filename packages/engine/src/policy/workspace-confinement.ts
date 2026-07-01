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
 * containment gate must not fail open on SDK shape drift). For `Bash` it is
 * BEST-EFFORT: only an absolute `cd`/`pushd` outside cwd is flagged. It is NOT a
 * sandbox — real containment is the OS sandbox (the tiered-sandbox roadmap). Known
 * residual gaps:
 *  - Bash write vectors other than `cd`: a redirect to an absolute path
 *    (`> /abs`), `tee`/`cp`/`mv`/`dd` to an absolute path, `sh -c`, subshells, or
 *    an exotic interpreter can still write outside cwd.
 *  - MCP file-writer tools (`mcp__<server>__write_file`, …) are not native tool
 *    names, so they are NOT confined. External MCP servers are opt-in (none ship
 *    by default) and classified `dangerous` (they prompt in non-bypass mode), but
 *    under `bypassPermissions` there is no prompt — treat an MCP write server as
 *    an isolation hole.
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
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { BASH_TOOL, parseCommandLine, type ToolDenyVerdict } from './tool-deny-policy.js';

/** Mutation tools whose target path is inspected → the input key holding it. */
const FILE_MUTATION_TARGET_KEY: Record<string, 'file_path' | 'notebook_path'> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Stable id surfaced in logs/telemetry when the confinement gate denies. */
export const WORKSPACE_CONFINEMENT_RULE_ID = 'workspace-confinement';

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

/** Lexically resolve `p` against `cwd` (an absolute `p` stands alone). No fs
 *  access, so a not-yet-created `Write` target still resolves. */
function resolveAgainst(cwd: string, p: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
}

/** True when `child` is `parent` itself or nested beneath it. Both are resolved
 *  absolute; the trailing-separator guard stops `/repo-evil` matching `/repo`. */
function isWithin(child: string, parent: string): boolean {
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
 *  when absent / not a non-empty string. */
function targetUnderKey(toolInput: unknown, key: string): string | undefined {
  if (toolInput === null || typeof toolInput !== 'object') return undefined;
  const value = (toolInput as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

  if (toolName === BASH_TOOL) {
    const escape = bashCdEscape(toolInput, roots);
    if (escape !== undefined) {
      return {
        denied: true,
        ruleId: WORKSPACE_CONFINEMENT_RULE_ID,
        reason: confinementReason(escape, resolvedCwd),
      };
    }
  }

  return { denied: false };
}
