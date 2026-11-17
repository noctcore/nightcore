import type { IMetaCtx, IMetaRule, IViolation } from '../lint-meta/types.js';
import { workflowFiles } from './workflow-files.js';
import { blockUnder, type ILineBlock, indentOf } from './yaml-lines.js';

export const GITHUB_ACTIONS_SECRET_NO_INSTALL_ID = 'github-actions-secret-no-install';

/**
 * A job that can read a stored secret must not install packages.
 *
 * A package install runs every dependency's lifecycle scripts, and anything a
 * script leaves behind (a patched binary in node_modules/.bin, a file a later
 * step executes) runs in every later step of the same job. So a secret that
 * any step of that job can see is readable by every package in the lockfile,
 * whichever step it is declared on. The fix is a job of its own that checks
 * out and runs the tool the secret is for, with no install; there is no
 * per-job allowlist, because a job that "really needs both" is exactly the
 * case the rule exists for.
 *
 * What counts:
 *   - a secret: any `secrets.<NAME>` in the job except `GITHUB_TOKEN` (the
 *     ephemeral token, scoped by the job's own `permissions:`), and any
 *     `secrets.<NAME>` in the workflow-level `env:` block, which every step of
 *     every job sees; `secrets: inherit` hands a called workflow all of them.
 *   - an install: `pnpm|npm|yarn|bun` `install|i|ci|add` inside a `run:`
 *     script, or `run_install: true` (pnpm/action-setup installs for you).
 *
 * `exemptSecrets` names a secret the rule does not count, each with the reason
 * and where its exposure is handled instead. It is a list of secrets, never of
 * jobs: every other secret in an exempted job still fails it.
 *
 * Line-based: comments are stripped first, then the top-level `env:` block and
 * each job under `jobs:` are read by indentation.
 */

/** A secret the rule does not count, and why that is safe to leave here. */
export interface ISecretExemption {
  readonly secret: string;
  readonly reason: string;
}

export interface IGithubActionsSecretNoInstallOptions {
  /** Secrets the rule does not count, each with a non-empty reason. Default none. */
  readonly exemptSecrets?: readonly ISecretExemption[];
}

/** A line with its YAML comment removed (a `#` at the start or after whitespace). */
function stripComment(line: string): string {
  return line.replace(/(^|\s)#.*$/u, '$1').trimEnd();
}

interface ISecretUse {
  readonly name: string;
  /** 1-based line. */
  readonly line: number;
}

const SECRET_REF = /\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/gu;

function secretUses(
  lines: readonly string[],
  block: ILineBlock,
  exempt: ReadonlySet<string>,
): ISecretUse[] {
  const uses: ISecretUse[] = [];
  for (let index = block.start; index < block.end; index += 1) {
    const line = lines[index] ?? '';
    for (const match of line.matchAll(SECRET_REF)) {
      const name = match[1] ?? '';
      if (name !== 'GITHUB_TOKEN' && !exempt.has(name)) {
        uses.push({ name, line: index + 1 });
      }
    }
    if (/^\s*secrets:\s*inherit\s*$/u.test(line)) {
      uses.push({ name: 'inherit (every secret)', line: index + 1 });
    }
  }
  return uses;
}

const INSTALL_COMMAND = /(?:^|[\s;&|(])(?:pnpm|npm|yarn|bun)\s+(?:install|i|ci|add)(?:\s|$|;)/u;

/** The 1-based lines of the job that install packages. */
function installLines(lines: readonly string[], block: ILineBlock): number[] {
  const found: number[] = [];
  for (let index = block.start; index < block.end; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*run_install:\s*['"]?true['"]?\s*$/u.test(line)) {
      found.push(index + 1);
      continue;
    }
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/u.exec(line);
    if (run === null) continue;
    const rest = (run[2] ?? '').trim();
    if (/^[|>][-+]?\d*$/u.test(rest)) {
      // A block scalar: the script is every deeper-indented line below.
      const script = blockUnder(lines, index);
      for (let body = script.start; body < script.end; body += 1) {
        if (INSTALL_COMMAND.test(lines[body] ?? '')) found.push(body + 1);
      }
    } else if (INSTALL_COMMAND.test(rest)) {
      found.push(index + 1);
    }
  }
  return found;
}

interface IJob {
  readonly id: string;
  readonly line: number;
  readonly block: ILineBlock;
}

function topLevelKey(lines: readonly string[], key: string): number {
  return lines.findIndex((line) => new RegExp(`^${key}:\\s*$`, 'u').test(line));
}

function jobsOf(lines: readonly string[]): IJob[] {
  const jobsIndex = topLevelKey(lines, 'jobs');
  if (jobsIndex === -1) return [];
  const all = blockUnder(lines, jobsIndex);
  const firstJob = lines
    .slice(all.start, all.end)
    .find((line) => line.trim() !== '' && /^\s+[A-Za-z0-9_-]+:\s*$/u.test(line));
  if (firstJob === undefined) return [];
  const jobIndent = indentOf(firstJob);

  const jobs: IJob[] = [];
  for (let index = all.start; index < all.end; index += 1) {
    const line = lines[index] ?? '';
    const key = /^(\s+)([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (key !== null && (key[1] ?? '').length === jobIndent) {
      jobs.push({ id: key[2] ?? '', line: index + 1, block: blockUnder(lines, index) });
    }
  }
  return jobs;
}

function describeUses(uses: readonly ISecretUse[]): string {
  return uses.map((use) => `\`${use.name}\` (line ${String(use.line)})`).join(', ');
}

/** The findings for one workflow's text, reported against `file`. */
export function checkSecretNoInstall(
  file: string,
  text: string,
  exemptions: readonly ISecretExemption[] = [],
): IViolation[] {
  const lines = text.split('\n').map(stripComment);
  const exempt = new Set(exemptions.map((exemption) => exemption.secret));

  const envIndex = topLevelKey(lines, 'env');
  const workflowSecrets =
    envIndex === -1 ? [] : secretUses(lines, blockUnder(lines, envIndex), exempt);

  const violations: IViolation[] = [];
  for (const job of jobsOf(lines)) {
    const installs = installLines(lines, job.block);
    if (installs.length === 0) continue;
    const installAt = `installs packages on line ${installs.map(String).join(', ')}`;

    const jobSecrets = secretUses(lines, job.block, exempt);
    if (jobSecrets.length > 0) {
      violations.push({
        file,
        rule: GITHUB_ACTIONS_SECRET_NO_INSTALL_ID,
        message: `Job \`${job.id}\` (line ${String(job.line)}) reads ${describeUses(jobSecrets)} and ${installAt}. Every package's lifecycle scripts run in that job, and what they leave behind runs in the step that holds the secret. Move the secret's step into a job of its own that checks out and runs no package install.`,
      });
    }
    if (workflowSecrets.length > 0) {
      violations.push({
        file,
        rule: GITHUB_ACTIONS_SECRET_NO_INSTALL_ID,
        message: `The workflow-level \`env:\` exposes ${describeUses(workflowSecrets)} to every step of every job, and job \`${job.id}\` (line ${String(job.line)}) ${installAt}. Declare the secret on the one step (in a job with no install) that needs it.`,
      });
    }
  }
  return violations;
}

/** A workflow job that can read a stored secret must not run a package install. */
export function createGithubActionsSecretNoInstallRule(
  options: IGithubActionsSecretNoInstallOptions = {},
): IMetaRule {
  const exemptions = [...(options.exemptSecrets ?? [])];
  for (const exemption of exemptions) {
    if (exemption.secret.trim() === '' || exemption.reason.trim() === '') {
      throw new Error(
        `${GITHUB_ACTIONS_SECRET_NO_INSTALL_ID}: every exempt secret needs a name and a reason (got "${exemption.secret}").`,
      );
    }
  }
  const exemptNote =
    exemptions.length === 0
      ? ''
      : `; exempt by name, each with its reason: ${exemptions.map((exemption) => exemption.secret).join(', ')}`;

  return {
    id: GITHUB_ACTIONS_SECRET_NO_INSTALL_ID,
    category: 'ci',
    ciCritical: true,
    description: `A workflow job that can read a stored secret (any \`secrets.*\` but GITHUB_TOKEN, workflow-level env included) must not run a package install${exemptNote}.`,
    run(ctx: IMetaCtx): IViolation[] {
      return workflowFiles(ctx).flatMap((file) =>
        checkSecretNoInstall(file, ctx.read(file) ?? '', exemptions),
      );
    },
  };
}
