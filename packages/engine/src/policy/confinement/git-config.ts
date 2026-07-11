/**
 * The git-config write-protection rule (`git-config-protection` rule id): DENY any
 * WRITE to a git config file git EXECUTES — `config` or `config.worktree`, whether
 * directly under a `.git` directory or under `.git/worktrees/<name>/`, at any depth —
 * the sibling of the sensitive-read denylist, but on the mutation side and INDEPENDENT
 * of cwd containment (a `.git/config` INSIDE the run cwd is denied too). Extracted as
 * its own confinement family; the orchestrator that dispatches to it stays in the
 * `workspace-confinement.ts` facade.
 *
 * WHY DENY, NOT CONFINE (issue #221). A committed `.gitattributes` (`* merge=evil`)
 * plus a `[merge "evil"] driver = <cmd>` — or a `filter.<name>.clean`/`.smudge`, or a
 * `diff.<name>.external` — written into a repo's `.git/config` makes git EXECUTE
 * `<cmd>` on the HOST during an ordinary `git merge` / `checkout` / `add`. The driver
 * NAME is attacker-chosen, so an allowlist over config keys cannot enumerate it; the
 * only durable defense is to refuse writing `.git/config` at all. This is a HARD DENY
 * (not the exec-sink ASK tier): unlike CI/hook files an agent sometimes legitimately
 * edits, hand-writing `.git/config` is never a legitimate agent action.
 *
 * SCOPE — narrow on purpose. Every git-EXECUTED config FILE is covered, and only for
 * WRITES. Git reads TWO file names as full config (both carry the merge/filter/diff
 * sections it runs): the repo `config`, AND `config.worktree` — git treats the latter
 * as a full config whenever `extensions.worktreeConfig=true`, which it auto-enables on
 * a legitimate `git sparse-checkout set` inside a worktree, so a poisoned
 * `config.worktree` is the SAME host-RCE as a poisoned `config`. Denied at any depth:
 *  - `.git/config` and `.git/config.worktree` (directly in a `.git` directory); and
 *  - `.git/worktrees/<name>/config` and `.git/worktrees/<name>/config.worktree` (the
 *    per-worktree config dir git keeps for a linked worktree).
 * NOT covered (left writable so normal git keeps working): reads of any of the above
 * (this is a mutation gate), `.git/index`, the `.git/refs` tree, `.git/HEAD`, and
 * `.git/hooks/config` (a `config` that is NOT directly under `.git`).
 *
 * LIMITS — lexical, like the rest of confinement. The native mutation tools
 * (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`), every `ApplyPatch` body target, and the
 * Bash write-vector tokens (redirects, `tee`/`cp`/`mv`/…) are matched by resolved
 * path. A write through a non-shell interpreter, a dynamic Bash target (`> $VAR/x`), a
 * symlink, or the `git config …` SUBCOMMAND (which mutates `.git/config` WITHOUT a
 * file-write tool) is NOT caught here — real containment is the OS sandbox (the
 * tiered-sandbox roadmap). Windows filename canonicalization (a trailing dot/space, or
 * an `::$DATA` ADS on `.git\config`) that resolves to the same file is likewise an
 * OS-sandbox-tier residual, not modeled by this lexical matcher. Path matching is
 * case-INSENSITIVE: on a case-insensitive filesystem (macOS/Windows) `.GIT/Config`
 * resolves to the same file, so folding case only ever STRENGTHENS the block.
 */
import { bashWriteTargetTokens, resolveBashWriteTargetInCwd } from './workspace.js';

/** Stable id surfaced in logs/telemetry when a `.git/config` write is denied (kept
 *  distinct from `workspace-confinement` so telemetry can tell a config-poisoning
 *  attempt apart from an ordinary out-of-cwd escape). */
export const GIT_CONFIG_PROTECTION_RULE_ID = 'git-config-protection';

/** Split a path into its non-empty segments across BOTH separators, so a
 *  Windows-style `\` path is segmented like the rest of the confinement helpers. */
function pathSegments(p: string): string[] {
  return p.split(/[\\/]/).filter((s) => s.length > 0);
}

/** The config FILE names git reads as a FULL config (merge/filter/diff sections it
 *  executes): the repo `config`, and `config.worktree` — which git treats as a full
 *  config whenever `extensions.worktreeConfig=true` (git auto-enables that on a
 *  `git sparse-checkout set` inside a worktree), so it carries the exact same
 *  `[merge "x"] driver` / `filter.*.clean` / `diff.*.textconv` host-RCE. */
const GIT_CONFIG_FILE_NAMES: ReadonlySet<string> = new Set(['config', 'config.worktree']);

/**
 * True when a resolved absolute path is a git config file whose contents git executes,
 * at ANY depth (case-folded — see the module header). Two shapes, both denied:
 *  - a `config` or `config.worktree` file DIRECTLY inside a `.git` directory; and
 *  - a `config` or `config.worktree` file under `.git/worktrees/<name>/` — the
 *    per-worktree config dir git keeps for a linked worktree, which it reads the same way.
 *
 * Deliberately narrow — these do NOT match: `.git/index`, the `.git/refs` tree,
 * `.git/HEAD`, `.git/hooks/config` (a `config` NOT directly under `.git`), and any
 * `config`/`config.worktree` outside a `.git` layout (`.github/config`, `x.git/config`,
 * a project's own `src/config`). Only git's executable-config surfaces are denied.
 */
export function isGitConfigWriteTarget(resolved: string): boolean {
  const segments = pathSegments(resolved);
  const n = segments.length;
  if (n < 2) return false;
  if (!GIT_CONFIG_FILE_NAMES.has(segments[n - 1]!.toLowerCase())) return false;
  // (a) `<.git>/config` or `<.git>/config.worktree` — directly inside a `.git` dir.
  if (segments[n - 2]!.toLowerCase() === '.git') return true;
  // (b) `<.git>/worktrees/<name>/config[.worktree]` — the per-worktree config git reads
  //     for a linked worktree (`<name>` is arbitrary, so it is unconstrained here).
  return (
    n >= 4 &&
    segments[n - 3]!.toLowerCase() === 'worktrees' &&
    segments[n - 4]!.toLowerCase() === '.git'
  );
}

/** The deny reason the agent sees — names the target and the RCE vector, and points
 *  at the honest escalation path rather than a workaround. */
export function gitConfigWriteReason(target: string): string {
  return (
    `Blocked by Nightcore safety policy: refusing to write ${target}. A git config ` +
    `file can define a merge driver, a clean/smudge filter, or an external diff ` +
    `command (e.g. [merge "name"] driver = <shell>) that git EXECUTES on this host ` +
    `during an ordinary merge/checkout/add — writing it is a one-shot ` +
    `remote-code-execution vector an autonomous run never needs. If a git setting is ` +
    `genuinely required, stop and report that to the user instead of editing ` +
    `.git/config directly.`
  );
}

/** The first Bash write target that resolves to a `.git/config` file (relative to
 *  `resolvedCwd`), or undefined. Reuses the shared bash write-target parser +
 *  relative resolver so this gate and the exec-sink gate never drift. An out-of-cwd
 *  or `~`-home `.git/config` is left to the confinement escape check, which already
 *  denies any write that leaves the run roots. */
export function bashGitConfigWriteTarget(
  command: string,
  resolvedCwd: string,
): string | undefined {
  for (const token of bashWriteTargetTokens(command)) {
    const resolved = resolveBashWriteTargetInCwd(token, resolvedCwd);
    if (resolved !== undefined && isGitConfigWriteTarget(resolved)) return resolved;
  }
  return undefined;
}
