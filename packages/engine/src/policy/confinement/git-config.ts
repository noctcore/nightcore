/**
 * The git-config write-protection rule (`git-config-protection` rule id): DENY any
 * WRITE to a git `config` file (a `config` file directly under a `.git` directory, at
 * any depth) — the sibling of the sensitive-read denylist, but on the mutation side
 * and INDEPENDENT of cwd containment (a
 * `.git/config` INSIDE the run cwd is denied too). Extracted as its own confinement
 * family; the orchestrator that dispatches to it stays in the `workspace-confinement.ts`
 * facade.
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
 * SCOPE — narrow on purpose. Only the `config` FILE is covered, and only for WRITES:
 *  - Reads of `.git/config` are NOT blocked (this is a mutation gate).
 *  - `.git/index`, `.git/refs/**`, `.git/HEAD`, `.git/config.worktree`, and
 *    `.git/hooks/config` do NOT match — git's own index/ref/HEAD writes must keep
 *    working, and only the top-level `config` file carries the merge/filter/diff
 *    sections git executes.
 *
 * LIMITS — lexical, like the rest of confinement. The native mutation tools
 * (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`), every `ApplyPatch` body target, and the
 * Bash write-vector tokens (redirects, `tee`/`cp`/`mv`/…) are matched by resolved
 * path. A write through a non-shell interpreter, a dynamic Bash target (`> $VAR/x`), a
 * symlink, or the `git config …` SUBCOMMAND (which mutates `.git/config` WITHOUT a
 * file-write tool) is NOT caught here — real containment is the OS sandbox (the
 * tiered-sandbox roadmap). Path matching is case-INSENSITIVE: on a case-insensitive
 * filesystem (macOS/Windows) `.GIT/Config` resolves to the same file, so folding case
 * only ever STRENGTHENS the block.
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

/**
 * True when a resolved absolute path is a git config file: a file named `config`
 * directly inside a directory named `.git`, at ANY depth. Case-folded (see the module
 * header). Deliberately narrow: `.git/config.worktree`, `.git/hooks/config`,
 * `.git/index`, the `.git/refs` tree, and `.git/HEAD` do NOT match —
 * only the `config` file whose merge/filter/diff sections git executes on the host.
 */
export function isGitConfigWriteTarget(resolved: string): boolean {
  const segments = pathSegments(resolved);
  if (segments.length < 2) return false;
  const last = segments[segments.length - 1]!.toLowerCase();
  const parent = segments[segments.length - 2]!.toLowerCase();
  return last === 'config' && parent === '.git';
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
