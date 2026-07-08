/**
 * The web↔Rust bridge's COMMAND surface. This barrel re-exports the per-domain
 * command modules under `./commands/`; each module either uses raw `invoke`
 * (rejecting outside Tauri) or `tauriInvoke` (degrading to a browser-preview mock
 * from `../mocks`). Event subscriptions live in `./events`; shared types in
 * `./types`. Call sites import from `@/lib/bridge` unchanged.
 */
export * from './commands/harness';
export * from './commands/insight';
export * from './commands/issues';
export * from './commands/models';
export * from './commands/onboarding';
export * from './commands/pr';
export * from './commands/pr-review';
export * from './commands/projects';
export * from './commands/run-interaction';
export * from './commands/scorecard';
export * from './commands/settings';
export * from './commands/tasks';
export * from './commands/worktrees';
