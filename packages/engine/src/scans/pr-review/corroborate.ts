/**
 * FUZZY cross-lens corroboration + ranking for the PR review (review-calibration
 * slice 2).
 *
 * Real-run evidence: corroboration fired `0/187` because the cross-lens merge keyed on
 * an EXACT normalized title (`dedupePrReviewFindings`) — two lenses describing the same
 * bug almost never phrase the headline identically, so `corroboratedBy` stayed empty and
 * the strongest available noise signal (two independent lenses agreeing) was invisible.
 *
 * This module adds the fuzzy pass that runs AFTER the exact dedup:
 *  - two findings corroborate when they come from DIFFERENT lenses, sit on the SAME file,
 *    and their normalized titles are similar at or above {@link CORROBORATION_TUNING}'s
 *    cutoff (Sørensen–Dice over token sets);
 *  - the higher-severity instance survives and the other reporting lenses are unioned
 *    into its `corroboratedBy`;
 *  - SAME-lens near-duplicates never merge here (that is ordinary dedup's job) — a
 *    cluster holds at most one finding per lens.
 *
 * Corroboration drives RANKING + DISPLAY ONLY. It must never change a `severity` and
 * therefore never moves the verdict clamp (`clamp.ts`) — the clamp reads the same
 * severities it would have read without this module. {@link rankPrReviewFindings} keeps
 * EVERY finding (no cap, no suppression, no demotion — transparency over brevity) and
 * only re-orders them.
 *
 * TUNING: every threshold lives in the single named {@link CORROBORATION_TUNING} record
 * so the cutoff can be retuned against real-run data once the T9 E2E harness (#150)
 * exists — deliberately not scattered as magic numbers through the matcher.
 *
 * Kept pure (contract types + the shared normalizers only; no SDK, no emitter) so every
 * step is unit-testable in isolation.
 */
import {
  type ReviewFinding,
  type ReviewLens,
  ReviewLensSchema,
} from '@nightcore/contracts';

import { normalizeFile, normalizeTitle, severityRank } from '../shared/findings.js';

/**
 * The ONE tunable record behind fuzzy corroboration. These are DEFAULTS chosen to be
 * conservative (a false corroboration inflates a finding's rank, so the cutoff sits
 * above "shares a couple of words"); calibrate them against real-run data once T9's
 * harness lands rather than editing the matcher.
 */
export const CORROBORATION_TUNING = {
  /**
   * Minimum Sørensen–Dice similarity (0‥1) between two normalized title token SETS for
   * them to count as the same issue. 0.6 ⇒ roughly "most of the meaningful words in the
   * shorter title also appear in the longer one".
   */
  similarityThreshold: 0.6,
  /**
   * Titles shorter than this many meaningful tokens are matched by EXACT token-set
   * equality instead of the ratio: with 1–2 tokens Dice jumps in coarse steps (a single
   * shared word already scores 0.5‥0.67), which would corroborate unrelated one-word
   * headlines.
   */
  minTokensForFuzzy: 3,
  /** Tokens shorter than this carry no meaning of their own and are dropped. */
  minTokenLength: 2,
} as const;

/**
 * Title words with no discriminating power in a review headline. Dropped before the
 * similarity ratio so "missing null check in parser" and "null check missing in the
 * parser" compare on their content words. Part of the tuning surface.
 */
const TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'for',
  'from',
  'has',
  'in',
  'into',
  'is',
  'it',
  'its',
  'may',
  'not',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'then',
  'there',
  'this',
  'to',
  'was',
  'when',
  'which',
  'will',
  'with',
]);

/** Lens display/tiebreak order — the contract's declaration order, so ranking is
 *  deterministic across runs and matches the UI's lens vocabulary. */
const LENS_ORDER: readonly ReviewLens[] = ReviewLensSchema.options;

/**
 * The meaningful token SET of a title: normalized (lowercase + collapsed whitespace by
 * the shared {@link normalizeTitle}), split on any non-alphanumeric run so
 * `snake_case`/`kebab-case`/`file.ts:12` all break into words, with stopwords and
 * sub-{@link CORROBORATION_TUNING.minTokenLength} fragments dropped. Exported for tests
 * + tuning.
 */
export function titleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const token of normalizeTitle(title).split(/[^a-z0-9]+/)) {
    if (token.length < CORROBORATION_TUNING.minTokenLength) continue;
    if (TITLE_STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

/**
 * Sørensen–Dice similarity of two token sets: `2·|A∩B| / (|A|+|B|)`, in `0‥1`. Two empty
 * sets score 0 (nothing meaningful to agree on) rather than 1 — an empty-token title
 * must never corroborate everything on its file.
 */
export function tokenSetSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Do two titles describe the same issue? Above {@link CORROBORATION_TUNING.minTokensForFuzzy}
 * tokens this is the Dice ratio against the cutoff; at or below it (where the ratio is
 * too coarse to trust) it demands an identical token set. Pure + total.
 */
export function titlesCorroborate(left: string, right: string): boolean {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size === 0 || b.size === 0) return false;
  const shortest = Math.min(a.size, b.size);
  if (shortest < CORROBORATION_TUNING.minTokensForFuzzy) {
    return a.size === b.size && [...a].every((token) => b.has(token));
  }
  return tokenSetSimilarity(a, b) >= CORROBORATION_TUNING.similarityThreshold;
}

/** One fuzzy cluster under construction: the members in encounter order, plus the
 *  lenses already represented (a cluster holds at most one finding per lens). */
interface Cluster {
  members: ReviewFinding[];
  lenses: Set<ReviewLens>;
}

/** Every lens the cluster carries — each member's own lens plus whatever the earlier
 *  exact dedup already recorded on it — so corroboration composes with dedup instead of
 *  overwriting it. */
function clusterLenses(cluster: Cluster): Set<ReviewLens> {
  const out = new Set<ReviewLens>();
  for (const member of cluster.members) {
    out.add(member.lens);
    for (const lens of member.corroboratedBy ?? []) out.add(lens);
  }
  return out;
}

/** The cluster's survivor: the highest-severity member, first-seen winning a tie (lens
 *  fan-out order is deterministic, so this is stable across runs). */
function clusterWinner(cluster: Cluster): ReviewFinding {
  let winner = cluster.members[0] as ReviewFinding;
  for (const member of cluster.members.slice(1)) {
    if (severityRank(member.severity) > severityRank(winner.severity)) winner = member;
  }
  return winner;
}

/**
 * FUZZY cross-lens corroboration. Runs AFTER {@link import('./findings.js').dedupePrReviewFindings}
 * (exact-title collapse) over the already-deduped set: near-duplicate findings from
 * DIFFERENT lenses on the SAME file collapse onto their highest-severity instance, whose
 * `corroboratedBy` unions the other reporting lenses.
 *
 * Order-stable on each cluster's first appearance. Severities are read, never written —
 * the survivor keeps its own severity, lens, id, and (lens-scoped) `fingerprint`, so the
 * Rust store's dismissed/converted history still matches a real fingerprint and the
 * verdict clamp sees exactly the severities it would have seen without this pass.
 */
export function corroboratePrReviewFindings(
  findings: readonly ReviewFinding[],
): ReviewFinding[] {
  // Clusters per normalized file — corroboration requires the same file, so no
  // cross-file comparison is ever made.
  const clustersByFile = new Map<string, Cluster[]>();
  // One flat list preserves each cluster's first-appearance position for the output.
  const ordered: Cluster[] = [];

  for (const finding of findings) {
    const file = normalizeFile(finding.file);
    let clusters = clustersByFile.get(file);
    if (clusters === undefined) {
      clusters = [];
      clustersByFile.set(file, clusters);
    }
    const match = clusters.find(
      (cluster) =>
        // SAME-lens near-dupes are ordinary dedup's business, never corroboration.
        !cluster.lenses.has(finding.lens) &&
        cluster.members.some((member) => titlesCorroborate(member.title, finding.title)),
    );
    if (match === undefined) {
      const fresh: Cluster = { members: [finding], lenses: new Set([finding.lens]) };
      clusters.push(fresh);
      ordered.push(fresh);
      continue;
    }
    match.members.push(finding);
    match.lenses.add(finding.lens);
  }

  return ordered.map((cluster) => {
    const winner = clusterWinner(cluster);
    const corroborators = [...clusterLenses(cluster)]
      .filter((lens) => lens !== winner.lens)
      .sort();
    return corroborators.length > 0
      ? { ...winner, corroboratedBy: corroborators }
      : winner;
  });
}

/** How many lenses back a finding: its own reporting lens plus its corroborators. A
 *  non-corroborated finding scores 1. */
export function corroborationCount(finding: ReviewFinding): number {
  return 1 + (finding.corroboratedBy?.length ?? 0);
}

/**
 * RANK the final finding set — severity desc → corroboration count desc → lens order →
 * stable input order. KEEPS EVERY FINDING: no per-lens budget, no cap, no suppression,
 * no demotion (locked decision — noise is handled by ranking, corroboration, and the
 * verdict clamp, never by hiding findings). Returns a new array; the input is untouched.
 */
export function rankPrReviewFindings(
  findings: readonly ReviewFinding[],
): ReviewFinding[] {
  const lensRank = (lens: ReviewLens): number => {
    const index = LENS_ORDER.indexOf(lens);
    return index === -1 ? LENS_ORDER.length : index;
  };
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const severity =
        severityRank(b.finding.severity) - severityRank(a.finding.severity);
      if (severity !== 0) return severity;
      const corroboration =
        corroborationCount(b.finding) - corroborationCount(a.finding);
      if (corroboration !== 0) return corroboration;
      const lens = lensRank(a.finding.lens) - lensRank(b.finding.lens);
      if (lens !== 0) return lens;
      return a.index - b.index;
    })
    .map((entry) => entry.finding);
}
