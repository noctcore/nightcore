/**
 * Composes the final `appendSystemPrompt` sent to the Claude Agent SDK from the
 * working-root directive, the (optional) trusted context pack, and the
 * (optional) kind-preset persona. Kept in its own module so the composition
 * ordering and truncation are unit-testable in isolation, without spinning a
 * `query()` or importing the rest of the option-composition surface.
 */

/**
 * A conservative character budget for the injected context pack.
 * The pack leads the system prompt, so an unbounded pack could crowd out the task
 * and the model's own reasoning budget. ~12k characters is roughly 3k tokens — a
 * generous Constitution + arch summary + convention rules + memory excerpts, while
 * leaving the bulk of the window for the actual run. Truncation is hard-capped here
 * (not at the Rust source) so the engine is the last line of defence regardless of
 * what the core hands over.
 */
export const CONTEXT_PACK_MAX_CHARS = 12_000;

/** A visible marker appended when the pack is truncated, so a reader (human or
 *  model) knows the Constitution was clipped rather than silently ending. */
const CONTEXT_PACK_TRUNCATION_NOTICE =
  '\n\n…[context pack truncated to fit the pre-flight budget]';

/** Separator between the working-root directive, the context pack, and the
 *  kind-preset persona in the composed `appendSystemPrompt`. A blank line keeps
 *  the trusted blocks visually distinct in the assembled system prompt. */
const CONTEXT_PACK_SEPARATOR = '\n\n';

/**
 * The authoritative working-directory directive that LEADS every run's system
 * prompt. Nightcore worktrees live nested inside the main checkout
 * (`<repo>/.nightcore/worktrees/<taskId>`), so a model that sees the worktree cwd
 * can trivially resolve "up" to the main repo root and edit the wrong tree
 * (observed 2026-07-01). This states plainly that the run cwd IS the repository
 * for the task and out-of-cwd writes are blocked — the prevent half of the pair
 * whose enforce half is `evaluateWorkspaceConfinement` (the PreToolUse gate).
 */
export function workingRootDirective(cwd: string): string {
  return (
    `# Working directory (authoritative)\n\n` +
    `Your working directory for this task is:\n  ${cwd}\n\n` +
    `Treat THIS directory as the repository root for the task. Make every file ` +
    `read, write, and edit inside it, and prefer paths relative to it. Do NOT ` +
    `operate on any other copy of the repository — do not \`cd\` to a parent ` +
    `directory, and do not use an absolute path that points outside this ` +
    `directory. Writes outside this directory are blocked and will fail.`
  );
}

/**
 * Compose the final `appendSystemPrompt` from the working-root directive, the
 * (optional) trusted context pack, and the (optional) kind-preset persona — in
 * that order, so the authoritative working root leads, then project rules, then
 * the reviewer/build persona. The pack is truncated to [`CONTEXT_PACK_MAX_CHARS`]
 * so it can't crowd out the task. Returns `undefined` only when every part is
 * absent (the working-root directive is always present for a real run, so the
 * option is effectively always set). Pure + exported so the ordering is
 * unit-testable without spinning a query.
 */
export function composeAppendSystemPrompt(
  workingRoot: string | undefined,
  contextPack: string | undefined,
  persona: string | undefined,
): string | undefined {
  const pack = contextPack?.trim();
  const boundedPack =
    pack !== undefined && pack.length > 0
      ? pack.length > CONTEXT_PACK_MAX_CHARS
        ? pack.slice(0, CONTEXT_PACK_MAX_CHARS) + CONTEXT_PACK_TRUNCATION_NOTICE
        : pack
      : undefined;
  const parts = [workingRoot?.trim() || undefined, boundedPack, persona].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join(CONTEXT_PACK_SEPARATOR) : undefined;
}
