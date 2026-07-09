/**
 * Board stories/tests fixtures, grouped into `_fixtures.<domain>` siblings and
 * re-exported here. This module stays the entry point for the task / PR / review /
 * worktree / gauntlet fixtures, so regrouping them never ripples into consumers.
 * The session fixtures are the exception: `_fixtures.sessions.ts` is imported
 * directly by the SessionHistory stories/tests and is deliberately not re-exported.
 */
export * from './_fixtures.gauntlet';
export * from './_fixtures.pr';
export * from './_fixtures.review';
export * from './_fixtures.task';
export * from './_fixtures.worktree';
