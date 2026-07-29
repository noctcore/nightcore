/**
 * `@nightcore/contracts` — the MATCHING SEMANTICS of the harness policy
 * patterns, colocated with the wire schema that declares them
 * ({@link import('./harness.js').HarnessPolicySchema}).
 *
 * WHY THIS LIVES IN THE CONTRACT SPINE. `protectedPaths`, `denyReadPaths`,
 * `denyBashPatterns`, `disallowedTools` and `askTools` are strings on the wire,
 * but their MEANING ("does `migrations/**` cover `migrations/001.sql`?") is as
 * much part of the contract as their type. Enforcement runs in the engine
 * (`packages/engine/src/policy/harness-policy.ts`); AUTHORING runs in the web
 * policy editor (issue #400 — the pattern tester + edit-time validation). Both
 * must answer that question IDENTICALLY, or the tester manufactures exactly the
 * false confidence the feature exists to remove. The engine may not be imported
 * by a surface (it owns the Claude SDK), so the one true matcher lives HERE —
 * rank 1, zero runtime deps, browser-safe — and the engine consumes it through
 * thin logger-aware wrappers (`policy/harness/*.ts`).
 *
 * This module is pure: no zod, no node builtins, no I/O. It is the semantics
 * only — target extraction, cwd resolution, tier ordering and the deny/ask
 * verdict all stay in the engine gate.
 *
 * GLOB SEMANTICS (documented on the wire schema, tested here):
 *   - `*` matches within a path segment, `**` matches zero or more segments.
 *   - A pattern containing `/` is ANCHORED at the run cwd (repo root).
 *   - A pattern without `/` FLOATS: it matches its segment at any depth
 *     (`*.lock` ⇒ any lockfile anywhere, gitignore-style).
 *   - A matched PREFIX protects the whole subtree (`migrations` ⇒ every file
 *     under `migrations/`), so non-glob patterns read naturally.
 *   - Matching is case-INSENSITIVE (see {@link segmentToRegex}): on a
 *     case-insensitive filesystem (macOS) a case-variant write lands in the
 *     protected file, so folding case only ever STRENGTHENS protection.
 *
 * Nothing here is a glob LIBRARY: `?`, `[...]` and `{a,b}` are NOT supported and
 * match literally — which is precisely why `./policy-lint.ts` exists to tell an
 * author their `{a,b}` rule is silently dead.
 */

/** The implicit self-protection pattern the engine ALWAYS prepends to
 *  `protectedPaths` whenever the policy layer is armed: `.nightcore/` holds the
 *  harness manifest, the task store and the flight recorder, so an agent must
 *  not be able to edit the enforcement config that gates it and then walk
 *  through the hole. Exported here so the authoring surfaces can show the rule
 *  the author never typed (it is enforced whether they know it or not). */
export const MANIFEST_PROTECTED_PATTERN = '.nightcore/**';

/** Max length of one `denyBashPatterns` regex; longer patterns are
 *  warn-and-skipped at compile (same path as an invalid regex). Caps the
 *  pattern half of the catastrophic-backtracking surface — the sidecar is a
 *  single process, so one pathological `RegExp.test` stalls every session. */
export const MAX_BASH_PATTERN_LENGTH = 512;

/** Only this many chars of a Bash command are tested against the deny
 *  patterns — the input half of the backtracking mitigation. A >16 KiB command
 *  is already pathological; a deny pattern that would only match PAST the cap
 *  fails open, which is acceptable for a heuristic gate. */
export const BASH_COMMAND_SCAN_LIMIT = 16 * 1024;

// --- Repo-relative path globs ----------------------------------------------

/** One compiled protected-path rule: the original pattern (for the deny reason)
 *  plus its segment matchers (`'**'` sentinel | a per-segment regex). */
export interface CompiledPathRule {
  pattern: string;
  segments: (RegExp | '**')[];
  /** True for a pattern without `/` — matched at any depth (gitignore-style). */
  floating: boolean;
}

/** Escape regex metacharacters, then translate `*` → "any run of non-separator
 *  characters". Case-insensitive (see the module header). */
function segmentToRegex(segment: string): RegExp {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\*/g, '[^/\\\\]*')}$`, 'i');
}

/** Compile one protected-path pattern, or undefined for an unusable (empty)
 *  one. Leading `./`/`/` and a trailing `/` are tolerated author sugar. */
export function compilePathRule(raw: string): CompiledPathRule | undefined {
  const trimmed = raw.trim().replace(/^\.?\//, '').replace(/\/+$/, '');
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  return {
    pattern: raw,
    segments: parts.map((p) => (p === '**' ? '**' : segmentToRegex(p))),
    floating: !trimmed.includes('/'),
  };
}

/** True when `rule` matches a prefix of `segments` starting at `from` — a full
 *  match protects the file, a prefix match protects the subtree beneath it. */
function matchesFrom(
  rule: CompiledPathRule,
  segments: readonly string[],
  from: number,
): boolean {
  const walk = (pi: number, si: number): boolean => {
    // Pattern exhausted ⇒ the consumed prefix matched (file itself or subtree).
    if (pi === rule.segments.length) return true;
    const part = rule.segments[pi]!;
    if (part === '**') {
      // `**` matches zero or more whole segments.
      for (let k = si; k <= segments.length; k += 1) {
        if (walk(pi + 1, k)) return true;
      }
      return false;
    }
    if (si >= segments.length) return false;
    return part.test(segments[si]!) && walk(pi + 1, si + 1);
  };
  return walk(0, from);
}

/** True when `rule` protects the cwd-relative path split into `segments`. An
 *  anchored rule matches from the root only; a floating rule from any depth. */
export function ruleProtects(rule: CompiledPathRule, segments: readonly string[]): boolean {
  if (!rule.floating) return matchesFrom(rule, segments, 0);
  for (let i = 0; i < segments.length; i += 1) {
    if (matchesFrom(rule, segments, i)) return true;
  }
  return false;
}

/** Split a REPO-RELATIVE path into the segment list {@link ruleProtects} takes.
 *  Both separators are accepted (a Windows-shaped relative path is the same
 *  path) and empty/`.` segments are dropped. The single owner of the split, so
 *  the engine gate and the authoring surfaces can never disagree on where a
 *  segment boundary is. Absolute-path resolution stays in the engine — a
 *  pattern is only ever meaningful against a repo-relative path. */
export function pathSegments(relativePath: string): string[] {
  return relativePath
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0 && segment !== '.');
}

/** The first rule in `rules` that protects `relativePath`, or undefined. The
 *  convenience entry point for a surface that holds a plain path (the pattern
 *  tester); the engine gate uses {@link ruleProtects} directly because it has
 *  already resolved + split the tool target. */
export function firstMatchingPathRule(
  rules: readonly CompiledPathRule[],
  relativePath: string,
): CompiledPathRule | undefined {
  const segments = pathSegments(relativePath);
  if (segments.length === 0) return undefined;
  return rules.find((rule) => ruleProtects(rule, segments));
}

// --- Bash deny regexes ------------------------------------------------------

/** A compiled `denyBashPatterns` entry, or the reason it can never fire.
 *  `error` is the shape both the engine's warn-and-skip and the editor's inline
 *  diagnostic are built from — one description of "this pattern is dead". */
export type BashPatternCompile =
  | { readonly regex: RegExp; readonly error?: undefined }
  | { readonly regex?: undefined; readonly error: string };

/**
 * Compile one project-authored Bash deny pattern. Patterns are JS regexes
 * matched against the RAW command line, case-sensitive (predictable for pattern
 * authors). An oversized or invalid pattern yields an `error` instead of a
 * regex: the engine warn-and-skips it (one typo must never brick the layer) and
 * the editor shows the SAME message inline, so the author learns at authoring
 * time what the engine would only whisper to a log.
 */
export function compileBashPattern(pattern: string): BashPatternCompile {
  if (pattern.length > MAX_BASH_PATTERN_LENGTH) {
    return {
      error:
        `pattern is ${pattern.length} chars — over the ${MAX_BASH_PATTERN_LENGTH}-char ` +
        'cap, so the engine skips it entirely',
    };
  }
  try {
    return { regex: new RegExp(pattern) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Test a Bash command line against one compiled deny regex, truncating the
 *  command to {@link BASH_COMMAND_SCAN_LIMIT} first (the input half of the
 *  backtracking mitigation). The engine and the tester share this so the
 *  tester's verdict is the gate's verdict, cap and all. */
export function bashPatternMatches(regex: RegExp, command: string): boolean {
  const bounded =
    command.length > BASH_COMMAND_SCAN_LIMIT
      ? command.slice(0, BASH_COMMAND_SCAN_LIMIT)
      : command;
  return regex.test(bounded);
}

// --- Tool tiers -------------------------------------------------------------

/** A compiled tool-tier matcher: exact SDK tool names plus `mcp__server__*`
 *  prefix globs. Match with {@link toolMatches}. */
export interface CompiledToolMatcher {
  /** Entries matched by identity (`WebSearch`, `mcp__acme__push`). */
  exact: ReadonlySet<string>;
  /** Prefixes from `mcp__…__*` entries — a call matches when its name STARTS
   *  WITH the prefix (`mcp__acme__*` ⇒ prefix `mcp__acme__`). */
  prefixes: readonly string[];
}

/** True for an `mcp__…__*` tier entry — the only entries that glob. A trailing
 *  `*` on an MCP entry becomes a server/prefix match (`mcp__acme__*` gates every
 *  `mcp__acme__…` tool); every other entry, including native tool names, is
 *  exact, so a literal name can never accidentally become a wildcard. */
export function isMcpGlobEntry(entry: string): boolean {
  return entry.startsWith('mcp__') && entry.endsWith('*');
}

/** True when `toolName` is gated by the matcher — an exact-name hit, or an
 *  `mcp__server__*` prefix the name starts with. */
export function toolMatches(matcher: CompiledToolMatcher, toolName: string): boolean {
  if (matcher.exact.has(toolName)) return true;
  return matcher.prefixes.some((prefix) => toolName.startsWith(prefix));
}

/**
 * Compile a tool-tier list into a {@link CompiledToolMatcher}. Pure: blank
 * entries are silently skipped (they gate nothing) — the engine's wrapper adds
 * the operator WARN and the dead-vs-deny diagnostic, the editor adds the inline
 * one. An `mcp__…__*` entry becomes a prefix glob (its trailing `*` dropped) so
 * it gates a whole MCP server; every other entry is exact.
 */
export function compileToolEntries(tools: readonly string[]): CompiledToolMatcher {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const tool of tools) {
    const trimmed = tool.trim();
    if (trimmed.length === 0) continue;
    if (isMcpGlobEntry(trimmed)) {
      prefixes.push(trimmed.slice(0, -1));
    } else {
      exact.add(trimmed);
    }
  }
  return { exact, prefixes };
}
