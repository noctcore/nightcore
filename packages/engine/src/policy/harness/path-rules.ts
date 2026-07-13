/**
 * The repo-relative glob-matching engine shared by the harness policy gate
 * (`../harness-policy.ts` — protected-path + read-deny tiers) and the exec-sink
 * write-protection gate (`../exec-sink.ts`). Extracted so both gates match
 * against the SAME anchored/floating + subtree-prefix semantics instead of two
 * engines drifting apart. The orchestrator (cwd resolution, tool-input target
 * extraction) stays in the harness-policy facade; this module owns only the
 * pattern-compile + segment-match core.
 *
 * GLOB SEMANTICS (documented on the wire schema, tested here):
 *   - `*` matches within a path segment, `**` matches zero or more segments.
 *   - A pattern containing `/` is ANCHORED at the run cwd (repo root).
 *   - A pattern without `/` FLOATS: it matches its segment at any depth
 *     (`*.lock` ⇒ any lockfile anywhere, gitignore-style).
 *   - A matched PREFIX protects the whole subtree (`migrations` ⇒ every file
 *     under `migrations/`), so non-glob patterns read naturally.
 *
 * Matching is case-INSENSITIVE (see {@link segmentToRegex}): on a
 * case-insensitive filesystem (macOS) a case-variant write lands in the
 * protected file, so folding case only ever STRENGTHENS protection (a Linux
 * false positive blocks a legitimately distinct case-variant path — rare,
 * accepted).
 */

/** One compiled protected-path rule: the original pattern (for the deny reason)
 *  plus its segment matchers (`'**'` sentinel | a per-segment regex). Exported
 *  (with {@link compilePathRule} / {@link ruleProtects}) so the exec-sink ASK gate
 *  reuses the SAME repo-relative glob engine — one home for the anchored/floating
 *  + subtree-prefix semantics both gates match against. */
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
