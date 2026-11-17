import type { IMetaCtx, IMetaRule, IViolation } from '../lint-meta/types.js';
import { workflowFiles } from './workflow-files.js';

export const GITHUB_ACTIONS_SECURITY_NO_CANCEL_ID = 'github-actions-security-no-cancel';

/**
 * A security workflow must give every pushed commit its own completed run.
 *
 * A secret-scanning workflow is the authoritative gate (a local hook is
 * defense-in-depth and `--no-verify` skips it), and it scans history. Two
 * concurrency shapes hide a commit from the scan without turning anything red:
 *
 *   1. `cancel-in-progress: true`. Push B cancels push A's run. A force-push
 *      that rewrites history leaves A's commit out of B's scan, so a key it
 *      contained is exposed (GitHub still serves the orphaned SHA) and nothing
 *      flags it.
 *   2. A group not keyed on the commit, even with `cancel-in-progress: false`.
 *      GitHub keeps one running and one pending run per group and a new run
 *      REPLACES the pending one, so the middle of three quick pushes never
 *      gets a run of its own.
 *
 * So a security workflow either has no `concurrency` block, or keys its group
 * on `github.sha` / `github.run_id` (a group nothing else shares) and does not
 * cancel. A workflow is a security workflow when its file name matches
 * `securityWorkflowName` (default: starts with `security-`) or when it runs the
 * gitleaks CLI or action.
 *
 * Line-based: comments are stripped first (a workflow's own explanation of why
 * it has no block may name `cancel-in-progress: true`), then every
 * `concurrency:` key is read in block, flow-mapping or scalar form, at the
 * workflow or at a job level.
 */
export interface IGithubActionsSecurityNoCancelOptions {
  /** Which workflow file names (basename) are security workflows. Default `/^security-.+\.ya?ml$/u`. */
  readonly securityWorkflowName?: RegExp;
}

const DEFAULT_SECURITY_NAME = /^security-.+\.ya?ml$/u;

function basename(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** A workflow whose name marks it as a security workflow, or any workflow that invokes gitleaks. */
function isSecurityWorkflow(file: string, lines: readonly string[], name: RegExp): boolean {
  if (name.test(basename(file))) {
    return true;
  }
  return lines.some(
    (line) =>
      /\bgitleaks\s+(?:git|detect|dir|protect|stdin)\b/u.test(line) ||
      /\buses:\s*\S*gitleaks/u.test(line),
  );
}

/** A line with its YAML comment removed (a `#` at the start or after whitespace). */
function stripComment(line: string): string {
  return line.replace(/(^|\s)#.*$/u, '$1').trimEnd();
}

function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/u, '$2').trim();
}

interface IConcurrency {
  /** 1-based line of the `concurrency:` key. */
  readonly line: number;
  readonly group: string | null;
  readonly cancel: string | null;
}

function readFlowMapping(body: string): { group: string | null; cancel: string | null } {
  const group = /\bgroup:\s*(.+?)\s*(?:,\s*cancel-in-progress:|\}\s*$)/u.exec(body)?.[1];
  const cancel = /\bcancel-in-progress:\s*(.+?)\s*(?:,\s*group:|\}\s*$)/u.exec(body)?.[1];
  return {
    group: group === undefined ? null : unquote(group),
    cancel: cancel === undefined ? null : unquote(cancel),
  };
}

function readConcurrencyBlocks(lines: readonly string[]): IConcurrency[] {
  const blocks: IConcurrency[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(\s*)concurrency:\s*(.*)$/u.exec(lines[index] ?? '');
    if (opener === null) {
      continue;
    }
    const indent = (opener[1] ?? '').length;
    const rest = (opener[2] ?? '').trim();

    if (rest.startsWith('{')) {
      blocks.push({ line: index + 1, ...readFlowMapping(rest) });
      continue;
    }
    if (rest !== '') {
      // `concurrency: some-group`: the scalar form names the group and cannot cancel.
      blocks.push({ line: index + 1, group: unquote(rest), cancel: null });
      continue;
    }

    let group: string | null = null;
    let cancel: string | null = null;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? '';
      if (line.trim() === '') {
        continue;
      }
      if ((/^(\s*)/u.exec(line)?.[1] ?? '').length <= indent) {
        break;
      }
      const key = /^\s*(group|cancel-in-progress):\s*(.*)$/u.exec(line);
      if (key?.[1] === 'group') {
        group = unquote(key[2] ?? '');
      } else if (key?.[1] === 'cancel-in-progress') {
        cancel = unquote(key[2] ?? '');
      }
    }
    blocks.push({ line: index + 1, group, cancel });
  }

  return blocks;
}

/** The commit-unique keys: the sha (of the push or of a PR head) or the run id. */
const COMMIT_KEYED = /\bgithub\.(?:sha|run_id)\b|\.head\.sha\b/u;

/** The findings for one workflow's text, reported against `file`. */
export function checkSecurityWorkflowNoCancel(
  file: string,
  text: string,
  securityWorkflowName: RegExp = DEFAULT_SECURITY_NAME,
): IViolation[] {
  const lines = text.split('\n').map(stripComment);
  if (!isSecurityWorkflow(file, lines, securityWorkflowName)) {
    return [];
  }

  const violations: IViolation[] = [];

  for (const block of readConcurrencyBlocks(lines)) {
    if (block.cancel !== null && block.cancel !== 'false') {
      violations.push({
        file,
        rule: GITHUB_ACTIONS_SECURITY_NO_CANCEL_ID,
        message: `Line ${String(block.line)}: security workflow sets \`cancel-in-progress: ${block.cancel}\`. A newer push would cancel an older commit's scan, and a force-push that rewrites history then leaves that commit unscanned while the newer run passes. Delete the \`concurrency\` block, or set \`cancel-in-progress: false\` and key the group on the commit.`,
      });
    }

    if (block.group === null || !COMMIT_KEYED.test(block.group)) {
      violations.push({
        file,
        rule: GITHUB_ACTIONS_SECURITY_NO_CANCEL_ID,
        message: `Line ${String(block.line)}: security workflow concurrency group ${block.group === null ? 'is not declared' : `\`${block.group}\` is not keyed on the commit`}. GitHub keeps one running and one pending run per group and a new run REPLACES the pending one, so the middle of several quick pushes never gets its own scan. Delete the \`concurrency\` block, or include \`github.sha\` or \`github.run_id\` in the group.`,
      });
    }
  }

  return violations;
}

/** A security workflow must not cancel scans or let a new run replace a pending one. */
export function createGithubActionsSecurityNoCancelRule(
  options: IGithubActionsSecurityNoCancelOptions = {},
): IMetaRule {
  const name = options.securityWorkflowName ?? DEFAULT_SECURITY_NAME;
  return {
    id: GITHUB_ACTIONS_SECURITY_NO_CANCEL_ID,
    category: 'ci',
    ciCritical: true,
    description:
      'Security workflows (security-*.yml by default, or any that runs gitleaks) must not cancel in-progress runs or share a concurrency group that lets a new run replace a pending one.',
    run(ctx: IMetaCtx): IViolation[] {
      return workflowFiles(ctx).flatMap((file) =>
        checkSecurityWorkflowNoCancel(file, ctx.read(file) ?? '', name),
      );
    },
  };
}
