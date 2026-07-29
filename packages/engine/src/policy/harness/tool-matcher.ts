/**
 * The MCP-aware tool-tier matcher used by the harness policy gate's
 * `disallowedTools` (module #9 least-privilege) and `askTools` (module #9 ask
 * tier) lists (`../harness-policy.ts`). An entry like `mcp__acme__*` gates
 * EVERY tool from the `acme` server with one line — a whole external MCP
 * server can be denied/asked without enumerating its tools, so a server that
 * later adds a tool doesn't silently escape the tier (#223). Every other
 * entry, MCP or native, matches EXACTLY, so a literal tool name can never
 * widen into a wildcard.
 *
 * The matcher shape + the pure compile/match core moved to
 * `@nightcore/contracts` (`policy-patterns.ts`, issue #400) so the web policy
 * editor's tester gates a tool name through the EXACT code the session gate
 * uses; this module keeps the operator-facing WARN diagnostics (empty entry,
 * ask-entry-shadowed-by-deny), which a contract-rank module has no logger for.
 */
import {
  type CompiledToolMatcher,
  compileToolEntries,
  toolMatches,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

export { type CompiledToolMatcher, toolMatches };

/**
 * Compile a tool-tier list into a {@link CompiledToolMatcher}. Empty/whitespace
 * entries are warn-and-skipped (one typo must never brick the layer). An
 * `mcp__…__*` entry becomes a prefix glob (its trailing `*` dropped) so it gates a
 * whole MCP server; every other entry is exact. When `denyMatcher` is supplied
 * (the askTools pass), an entry it already gates is flagged as dead config — deny
 * wins over ask, so the author learns the ask entry is not a softer deny.
 */
export function compileToolMatcher(
  tools: readonly string[],
  listName: string,
  logger?: Logger,
  denyMatcher?: CompiledToolMatcher,
): CompiledToolMatcher {
  for (const tool of tools) {
    const trimmed = tool.trim();
    if (trimmed.length === 0) {
      logger?.warn(`skipping empty harness ${listName} entry`);
      continue;
    }
    if (denyMatcher !== undefined && toolMatches(denyMatcher, trimmed)) {
      logger?.warn(`${listName} entry is also in disallowedTools; deny wins`, {
        tool: trimmed,
      });
    }
  }
  return compileToolEntries(tools);
}
