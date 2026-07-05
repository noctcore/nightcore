/**
 * Shared anti-prompt-injection primitive for the scan pipelines: a delimiter-safe
 * wrapper for ATTACKER-CONTROLLED text (GitHub issue/comment/PR bodies, diffs) so a
 * read-only analysis pass can be told to treat it as DATA, never as instructions.
 *
 * Lives in `shared/` — NOT in a single feature module — because it is a general,
 * security-relevant helper, the same reason {@link import('./findings.js').fileExists}'s
 * containment check and {@link import('./findings.js').extractJson} live here: one source
 * of truth every untrusted-input scan can adopt without re-declaring (and diverging)
 * the logic. Issue-triage uses it today; any other scan that ingests untrusted material
 * (PR-review's diff, a future intake) can import the same wrapper.
 */

/**
 * Wrap ATTACKER-CONTROLLED text in a labelled untrusted fence. The model is instructed
 * (via the pass persona) to treat everything between the markers as DATA to analyze,
 * never as instructions.
 *
 * This is DEFENSE-IN-DEPTH, not a structural guarantee. Before fencing, any literal
 * `BEGIN/END UNTRUSTED` marker keyword the attacker embedded in `content` is neutralized
 * (see {@link neutralizeFences}), so the produced string carries exactly ONE real
 * `BEGIN UNTRUSTED` / `END UNTRUSTED` pair — the attacker cannot reproduce this wrapper's
 * own delimiter verbatim. But that is a KEYWORD-SCOPED HEURISTIC against a model that
 * interprets semantics, not a proof of containment: a paraphrased, translated, or
 * otherwise reworded terminator the model might still honor as "end of block" is NOT
 * caught. The primary control against injection is the read-only toolset (no execution
 * surface — nothing the untrusted text says can be run or written); this framing only
 * reduces the odds a crafted marker biases the emitted verdict.
 */
export function untrustedBlock(label: string, content: string): string {
  const tag = label.toUpperCase().trim();
  return [
    `<<<BEGIN UNTRUSTED ${tag}>>>`,
    neutralizeFences(content),
    `<<<END UNTRUSTED ${tag}>>>`,
  ].join('\n');
}

/** Neutralize any embedded `BEGIN|END UNTRUSTED` marker keyword (with or without the
 *  surrounding angle brackets / a trailing tag) so the attacker's text cannot reproduce
 *  this wrapper's literal open/close delimiter. Keyword-scoped, NOT structural: a
 *  paraphrased/localized terminator is not matched (see {@link untrustedBlock}). Matching
 *  on the keyword pair (not just the brackets) means a diff's git-conflict markers
 *  (`<<<<<<<` / `>>>>>>>`) — which carry no `UNTRUSTED` keyword — survive intact. */
export const FENCE_MARKER_RE = /<*\s*\b(?:BEGIN|END)\s+UNTRUSTED\b[^\n>]*>*/gi;

/** Replace every literal `BEGIN|END UNTRUSTED` marker keyword in `content`. Exported so
 *  a scan can neutralize a field without re-wrapping it, and so the behavior is testable
 *  directly. */
export function neutralizeFences(content: string): string {
  return content.replace(FENCE_MARKER_RE, '(untrusted-marker removed)');
}
