/** Bridge commands — PR Review (the fourth scan sibling) and the PR fix arc
 *  (address findings / fix CI / resolve conflicts / push). */
import { invoke } from '@tauri-apps/api/core';

import { isTauri, tauriInvoke } from '../internal';
import type {
  EffortLevel,
  PrChangedFile,
  PrFixState,
  PrReviewRun,
  PrSummary,
  ReviewLens,
  Task,
} from '../types';

// --- PR Review (fourth scan sibling) --------------------------------------

/** One inline review comment posted alongside a GitHub review: a diff anchor
 *  (`path` + 1-based `line`) plus the Nightcore-composed body. */
export interface ReviewInlineComment {
  path: string;
  line: number;
  body: string;
}

/** The three GitHub review verdicts in the web's kebab wire form (the Rust core
 *  maps them to gh's `APPROVE` / `REQUEST_CHANGES` / `COMMENT`). */
export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';

/** Start a PR Review run over the active project's pull request `prNumber`. Returns
 *  the `runId` the `pr-review-*` events correlate by. The project path is resolved
 *  server-side from the active project (never passed). Rejects outside Tauri. */
export async function startPrReview(
  prNumber: number,
  lenses: ReviewLens[],
  options: { model?: string | null; effort?: EffortLevel | null; providerId?: string | null } = {},
): Promise<string> {
  return invoke<string>('start_pr_review', {
    prNumber,
    lenses,
    model: options.model ?? null,
    effort: options.effort ?? null,
    providerId: options.providerId ?? null,
  });
}

/** Cancel an in-flight PR Review run (aborts every lens pass). No-op outside Tauri. */
export async function cancelPrReview(runId: string): Promise<void> {
  await tauriInvoke<void>('cancel_pr_review', { runId }, undefined);
}

/** The active project's OPEN pull requests (newest first, capped), for the PR
 *  Review config picker. `limit` is OPTIONAL — omitted lets the backend apply its
 *  default (50) and clamps to `1..=200`, so "load more" refetches at a doubled cap
 *  without an unbounded fetch. `[]` outside Tauri. Rejects (throws) on a gh failure
 *  so the picker can surface "not a repo / gh not installed / auth" inline. */
export async function listOpenPrs(limit?: number): Promise<PrSummary[]> {
  if (!isTauri()) return [];
  return invoke<PrSummary[]>('list_open_prs', { limit: limit ?? null });
}

/** A pull request's changed files (path + per-file line deltas) for the PR Review
 *  workspace's changed-file expander. Read-only `gh pr view --json files`, bounded
 *  + capped Rust-side; on-demand only (fetched when the expander first opens; NO
 *  polling). Every `path` is gh pass-through (untrusted contributor content) the
 *  web renders as inert text. Resolves `[]` outside Tauri (browser preview) so the
 *  expander shows its empty note instead of a fabricated list. */
export async function prChangedFiles(number: number): Promise<PrChangedFile[]> {
  return tauriInvoke<PrChangedFile[]>('pr_changed_files', { number }, []);
}

/** All PR Review runs for the active project, newest first. `[]` outside Tauri. */
export async function listPrReviewRuns(): Promise<PrReviewRun[]> {
  return tauriInvoke<PrReviewRun[]>('list_pr_review_runs', {}, []);
}

/** One PR Review run by id, or `null`. `null` outside Tauri. */
export async function getPrReviewRun(runId: string): Promise<PrReviewRun | null> {
  return tauriInvoke<PrReviewRun | null>('get_pr_review_run', { runId }, null);
}

/** Mark a review finding dismissed (it stays dismissed across future re-runs).
 *  Returns the updated run. No-op (`null`) outside Tauri. */
export async function dismissReviewFinding(
  runId: string,
  findingId: string,
): Promise<PrReviewRun | null> {
  return tauriInvoke<PrReviewRun | null>(
    'dismiss_review_finding',
    { runId, findingId },
    null,
  );
}

/** Restore a dismissed review finding back to open. Returns the updated run. */
export async function restoreReviewFinding(
  runId: string,
  findingId: string,
): Promise<PrReviewRun | null> {
  return tauriInvoke<PrReviewRun | null>(
    'restore_review_finding',
    { runId, findingId },
    null,
  );
}

/** Convert a review finding into a board task (idempotent). Returns the created task. */
export async function convertReviewFindingToTask(
  runId: string,
  findingId: string,
): Promise<Task> {
  return invoke<Task>('convert_review_finding_to_task', { runId, findingId });
}

/** Delete a PR Review run and its file. No-op outside Tauri. */
export async function deletePrReviewRun(runId: string): Promise<void> {
  await tauriInvoke<void>('delete_pr_review_run', { runId }, undefined);
}

/** Post a review to GitHub — the terminal, human-gated action. The Rust core
 *  composes ONE `gh api POST …/reviews` carrying `{event, body, comments[]}`.
 *  `verdict` is the web kebab form; `body` + `comments` are Nightcore-composed from
 *  the SELECTED findings (our own trusted text — never raw foreign diff). The
 *  optional `runId` stamps the originating run's `postedVerdict` / `postedAt` on
 *  a successful post (the Rust command takes an optional run id). Uses raw
 *  `invoke` (like {@link applyHarnessArtifact}) so a gh failure surfaces to the
 *  caller. Rejects outside Tauri (no active project). */
export async function postReviewToGithub(
  prNumber: number,
  verdict: ReviewVerdict,
  body: string,
  comments: ReviewInlineComment[],
  runId?: string | null,
): Promise<void> {
  await invoke<void>('post_review_to_github', {
    prNumber,
    verdict,
    body,
    comments,
    runId: runId ?? null,
  });
}

// --- PR fix (address findings / fix CI / resolve conflicts) -----------------

/** Run a fix agent over the SELECTED findings of a review run, on the PR's own
 *  branch. Returns the fix id the `nc:pr-fix` snapshots correlate by. The session
 *  auto-commits on completion and parks at `awaiting_push` — {@link pushPrFix} is
 *  the separate human-gated publish. Uses raw `invoke` (like {@link startPrReview})
 *  so a refusal (fork PR / missing checkout / a fix already running on this PR)
 *  surfaces to the caller. Rejects outside Tauri. */
export async function addressReviewFindings(
  runId: string,
  findingIds: string[],
): Promise<string> {
  return invoke<string>('address_review_findings', { runId, findingIds });
}

/** Run a fix agent over the PR's FAILING CI CHECKS, on the PR's own branch (the
 *  same arc as {@link addressReviewFindings} — auto-commit, then the human-gated
 *  push). Refuses when the PR has no failing checks. Rejects outside Tauri. */
export async function fixPrCi(prNumber: number): Promise<string> {
  return invoke<string>('fix_pr_ci', { prNumber });
}

/** Merge the PR's base branch into its checkout and — when the merge stops on
 *  conflicts — run a fix agent that resolves them (a CLEAN merge skips the agent
 *  and parks the merge commit at `awaiting_push` directly). Refuses when the
 *  branch is already up to date with base. Rejects outside Tauri. */
export async function resolvePrConflicts(prNumber: number): Promise<string> {
  return invoke<string>('resolve_pr_conflicts', { prNumber });
}

/** Push an `awaiting_push` fix's branch to origin — THE human-gated external side
 *  effect of the fix arc (plain push, never force; a diverged remote fails loudly).
 *  `postComment` additionally posts a summary comment on the PR explaining how the
 *  fix addressed its targets; the comment is best-effort — when it fails AFTER a
 *  successful push, the resolved string is that warning (null = nothing to warn).
 *  Raw `invoke` so a gh/git failure surfaces to the caller. Rejects outside Tauri. */
export async function pushPrFix(
  fixId: string,
  postComment: boolean,
): Promise<string | null> {
  return invoke<string | null>('push_pr_fix', { fixId, postComment });
}

/** Every registered fix, newest first. The registry is in-memory Rust-side — an
 *  app restart forgets entries (the commit survives on the branch). `[]` outside
 *  Tauri. */
export async function listPrFixes(): Promise<PrFixState[]> {
  return tauriInvoke<PrFixState[]>('list_pr_fixes', {}, []);
}

/** Cancel a running fix (interrupts the session; the fix lands as
 *  `failed("cancelled")` on `nc:pr-fix`). No-op outside Tauri. */
export async function cancelPrFix(fixId: string): Promise<void> {
  await tauriInvoke<void>('cancel_pr_fix', { fixId }, undefined);
}

