/**
 * The human-readable deny/ask reason strings the harness policy gate
 * (`../harness-policy.ts`) attaches to a verdict — shown to the model (so it
 * stops and reports rather than retrying variants) and, for the ask tier, as
 * the user's permission-prompt context.
 */

/** The deny reason for a protected-path match — names the target AND the pattern
 *  so the model understands the rail rather than retrying variants, and points it
 *  at the honest escalation path (report to the user). */
export function protectedPathReason(target: string, pattern: string): string {
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
export function bashDenyReason(pattern: string): string {
  return (
    `Blocked by this project's harness policy: this command matches the project's ` +
    `deny pattern "${pattern}". The project forbids this command form in autonomous ` +
    `runs (typically because it bypasses hooks, verification, or dependency ` +
    `integrity). Accomplish the task without it, or stop and report to the user.`
  );
}

/** The deny reason for a read-deny match — the target is secret material or a
 *  quarantined (injection-flagged) file the project declared off-limits. */
export function readDenyReason(target: string, pattern: string): string {
  return (
    `Blocked by this project's harness policy: reading ${target} is refused — it ` +
    `matches the read-denied pattern "${pattern}". Read-denied paths hold secret ` +
    `material (.env files, keys) or content quarantined as a prompt-injection ` +
    `risk. The task must not depend on this file's contents; if it genuinely ` +
    `does, stop and report that to the user.`
  );
}

/** The deny reason when a tool is disallowed outright for this project. */
export function toolDenyReason(toolName: string): string {
  return (
    `Blocked by this project's harness policy: the ${toolName} tool is disallowed ` +
    `for autonomous runs in this project (least-privilege configuration). ` +
    `Accomplish the task with the remaining tools, or stop and report to the user.`
  );
}

/** The reason carried on an ask escalation — shown as the permission prompt's
 *  context (user) and as the decision reason (agent transcript). */
export function toolAskReason(toolName: string): string {
  return (
    `This project's harness policy requires interactive approval for the ` +
    `${toolName} tool (ask tier, least-privilege configuration). The call has ` +
    `been escalated to the user; wait for their decision.`
  );
}
