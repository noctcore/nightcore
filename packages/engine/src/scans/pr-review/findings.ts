/**
 * Pure helpers for the PR Review pipeline — the parse → ground → dedup steps that
 * turn a lens pass's free-text result into validated, DIFF-GROUNDED, de-duplicated
 * {@link ReviewFinding}s. Mirrors the Insight `shared/findings.ts` (and REUSES its
 * `extractJson` + `coerceLocation` + `normalizeFile` primitives) so the features
 * parse the model the same way, but grounds DIFF-RELATIVE rather than disk-relative:
 *
 * A PR that ADDS `new.rs` has no `new.rs` in the current checkout, so disk-grounding
 * (does the file exist on disk?) would wrongly drop a real finding. Instead a finding
 * is kept iff its `file` is a member of the PR's `changedFiles` set, and line numbers
 * are NOT clamped to disk length (we don't have the PR-head file). This is the whole
 * reason the scan reviews the diff without a checkout — see the phase-4 contract §0.
 *
 * Kept pure (only `crypto`, no SDK, no emitter, no `fs`) so every step is
 * unit-testable in isolation.
 */
import { createHash } from 'node:crypto';

import {
  type ReviewFinding,
  ReviewFindingSchema,
  type ReviewLens,
  type ReviewSeverity,
} from '@nightcore/contracts';

import { getNumber, getString } from '../../util/field-extract.js';
import { coerceLocation, extractJson, normalizeFile } from '../shared/findings.js';

/** Severity ordering for ranking/merge (low → high). Shares its value-set with the
 *  Insight scale but is defined locally so PR review carries no coupling to it. */
const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Numeric rank for a review severity (info=0 … critical=4), for ordering and merge. */
export function reviewSeverityRank(s: ReviewSeverity): number {
  return SEVERITY_RANK[s];
}

/** Normalize a title for fingerprinting/dedup: lowercase, collapse whitespace. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Stable content fingerprint for a review finding: `lens | normalized-file | title`.
 * Line-independent (a one-line drift between re-runs must not break the
 * dismissed-history match the Rust store keys on) and lens-scoped (the same headline
 * means different things under `security` vs `structure`). Used both to carry
 * dismissed-history across re-runs AND to dedup across lens passes, so the two can
 * never diverge. Returns a short hex digest.
 */
export function reviewFingerprint(
  lens: ReviewLens,
  file: string,
  title: string,
): string {
  const basis = `${lens}|${normalizeFile(file)}|${normalizeTitle(title)}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/** The model's raw output is an array of finding objects, or an object with a
 *  `findings` array. Normalize to an array. */
function toRawArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') {
    const findings = (parsed as Record<string, unknown>).findings;
    if (Array.isArray(findings)) return findings;
  }
  return [];
}

/** Map a raw severity onto the unified scale, tolerant of common synonyms. */
function coerceSeverity(raw: unknown): ReviewSeverity {
  const v = String(raw).toLowerCase();
  if (v in SEVERITY_RANK) return v as ReviewSeverity;
  if (v === 'warning' || v === 'minor' || v === 'suggestion') return 'low';
  if (v === 'major' || v === 'error') return 'high';
  return 'medium';
}

/** Keep a line number only when it is a positive integer (the contract's shape);
 *  anything else is dropped so the whole finding does not fail schema validation. */
function coerceLine(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < 1) return undefined;
  return raw;
}

/**
 * Coerce one raw model item into a contract {@link ReviewFinding}, forcing `lens`
 * (the pass owns it, not the model) and assigning a stable id + fingerprint. Accepts
 * the flat `{ file, line }` shape the contract wants and, defensively, a nested
 * `location` object or a `"file:line"` string (the model occasionally reports one).
 * A finding with no locatable `file` is dropped (the contract requires it, and
 * diff-relative grounding is meaningless without a file). Returns `undefined` when
 * the item can't satisfy the schema.
 */
function coerceReviewFinding(
  raw: unknown,
  lens: ReviewLens,
): ReviewFinding | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  const title = getString(r, 'title');
  // `body` is the contract field; accept `description` as a fallback (the analyzer
  // vocabulary the model sometimes reaches for).
  const body = getString(r, 'body') ?? getString(r, 'description');
  if (title === undefined || body === undefined) return undefined;

  // `coerceLocation` normalizes the path and parses a `"file:line"` string; feed it
  // either the flat `file` field or a nested `location`.
  const loc = coerceLocation(r.location ?? r.file);
  const file = loc?.file;
  if (file === undefined || file.length === 0) return undefined;

  const line = coerceLine(getNumber(r, 'line') ?? loc?.startLine);
  const suggestedFix = getString(r, 'suggestedFix') ?? getString(r, 'suggestion');
  const fingerprint = reviewFingerprint(lens, file, title);

  const candidate: Record<string, unknown> = {
    id: `${lens}-${fingerprint}`,
    lens,
    severity: coerceSeverity(r.severity),
    file,
    ...(line !== undefined ? { line } : {}),
    title,
    body,
    ...(suggestedFix !== undefined ? { suggestedFix } : {}),
    fingerprint,
  };

  const result = ReviewFindingSchema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

/**
 * Parse a lens pass's raw result text into validated findings. Tolerant: malformed
 * items are skipped, not fatal. Returns the parsed findings plus an `error` when NO
 * JSON could be extracted at all (so the orchestrator can drive its single corrective
 * retry / mark the lens errored vs legitimately empty).
 */
export function parsePrReviewFindings(
  raw: string,
  lens: ReviewLens,
): { findings: ReviewFinding[]; error?: string } {
  const parsed = extractJson(raw);
  if (parsed === undefined) {
    return { findings: [], error: 'no JSON review findings in model output' };
  }
  const items = toRawArray(parsed);
  const findings: ReviewFinding[] = [];
  for (const item of items) {
    const finding = coerceReviewFinding(item, lens);
    if (finding !== undefined) findings.push(finding);
  }
  return { findings };
}

/**
 * DIFF-RELATIVE grounding: keep a finding iff its `file` is a member of the PR's
 * changed-file set, and DROP the rest. This is deliberately NOT disk existence — a PR
 * adds files that are not in the current checkout, and reviews the diff, not a
 * checkout of the PR head. Line numbers are NOT clamped (we have no PR-head file to
 * clamp against). Paths are normalized on both sides so `./a`, `a`, and `a\` compare
 * equal.
 */
export function groundPrReviewFindings(
  findings: ReviewFinding[],
  changedFiles: readonly string[],
): ReviewFinding[] {
  const changed = new Set(changedFiles.map((f) => normalizeFile(f)));
  return findings.filter((f) => changed.has(normalizeFile(f.file)));
}

/**
 * Cross-lens dedup: when two lens passes surface the same issue, keep ONE — the
 * higher-severity instance. The dedup key IS the `fingerprint` (`lens | file |
 * title`), so it can never diverge from the dismissed-history key: a finding the user
 * dismissed in a prior run matches the same survivor here. Order-stable on first
 * appearance. (Note: because the fingerprint includes the lens, two different lenses
 * only collide when they independently produce the identical file+title — rare, but
 * then the higher-severity reading wins.)
 */
export function dedupePrReviewFindings(
  findings: ReviewFinding[],
): ReviewFinding[] {
  const byKey = new Map<string, ReviewFinding>();
  const order: string[] = [];
  for (const finding of findings) {
    const key = finding.fingerprint;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, finding);
      order.push(key);
      continue;
    }
    const winner =
      reviewSeverityRank(finding.severity) > reviewSeverityRank(existing.severity)
        ? finding
        : existing;
    byKey.set(key, winner);
  }
  return order.map((key) => byKey.get(key) as ReviewFinding);
}
