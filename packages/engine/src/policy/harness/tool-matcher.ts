/**
 * The MCP-aware tool-tier matcher used by the harness policy gate's
 * `disallowedTools` (module #9 least-privilege) and `askTools` (module #9 ask
 * tier) lists (`../harness-policy.ts`). An entry like `mcp__acme__*` gates
 * EVERY tool from the `acme` server with one line — a whole external MCP
 * server can be denied/asked without enumerating its tools, so a server that
 * later adds a tool doesn't silently escape the tier (#223). Every other
 * entry, MCP or native, matches EXACTLY, so a literal tool name can never
 * widen into a wildcard.
 */
import type { Logger } from '@nightcore/shared';

/** A compiled tool-tier matcher: exact SDK tool names plus `mcp__server__*` prefix
 *  globs. Match with {@link toolMatches}. */
export interface CompiledToolMatcher {
  /** Entries matched by identity (`WebSearch`, `mcp__acme__push`). */
  exact: ReadonlySet<string>;
  /** Prefixes from `mcp__…__*` entries — a call matches when its name STARTS WITH
   *  the prefix (`mcp__acme__*` ⇒ prefix `mcp__acme__`). */
  prefixes: readonly string[];
}

/** True for an `mcp__…__*` tier entry — the only entries that glob. A trailing
 *  `*` on an MCP entry becomes a server/prefix match (`mcp__acme__*` gates every
 *  `mcp__acme__…` tool); every other entry, including native tool names, is exact,
 *  so a literal name can never accidentally become a wildcard. */
function isMcpGlob(entry: string): boolean {
  return entry.startsWith('mcp__') && entry.endsWith('*');
}

/** True when `toolName` is gated by the matcher — an exact-name hit, or an
 *  `mcp__server__*` prefix the name starts with. Exported so the ask and deny
 *  tiers share one matching rule. */
export function toolMatches(matcher: CompiledToolMatcher, toolName: string): boolean {
  if (matcher.exact.has(toolName)) return true;
  return matcher.prefixes.some((prefix) => toolName.startsWith(prefix));
}

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
  const exact = new Set<string>();
  const prefixes: string[] = [];
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
    if (isMcpGlob(trimmed)) {
      prefixes.push(trimmed.slice(0, -1));
    } else {
      exact.add(trimmed);
    }
  }
  return { exact, prefixes };
}
