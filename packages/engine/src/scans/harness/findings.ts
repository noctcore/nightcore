/**
 * Pure helpers for the Harness convention pipeline — the parse → ground → dedup
 * steps that turn a convention pass's free-text result into validated, grounded,
 * de-duplicated {@link ConventionFinding}s. Mirrors `analysis-findings.ts` (and
 * REUSES its `extractJson` + the shared `field-extract` primitives) so the two
 * features parse the model the same way, but is shaped for conventions: `evidence`
 * is a LIST of file anchors (a convention is a repo-wide pattern, not a single
 * line), `kind` separates an observed rule from a missing best practice, and a
 * fileless convention is KEPT (conventions are legitimately repo-wide), unlike a
 * fileless Insight finding which carries no location at all.
 *
 * Kept pure (only `fs`/`crypto`, no SDK, no emitter) so every step is unit-testable
 * in isolation.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import {
  type ConventionCategory,
  type ConventionFinding,
  ConventionFindingSchema,
  type ConventionKind,
  type FindingLocation,
  type FindingSeverity,
} from '@nightcore/contracts';

import { getNumber, getString, getStringArray } from '../../util/field-extract.js';
import {
  clampLocationLines,
  coerceLocation,
  extractJson,
  fileExists,
  lineCount,
} from '../shared/findings.js';

/** Severity ordering for ranking/merge (low → high). */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Normalize a title for fingerprinting/dedup: lowercase, collapse whitespace. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Stable content fingerprint for a convention: `category | title`. Unlike
 * Insight's category-INDEPENDENT fingerprint, conventions are category-scoped (the
 * same headline means different things under `naming` vs `architecture`), so the
 * category is part of the key. Carries dismissed-history across re-runs (the Rust
 * store matches on it) AND dedups across passes. Returns a short hex digest.
 */
export function conventionFingerprint(
  category: ConventionCategory,
  title: string,
): string {
  const basis = `${category}|${normalizeTitle(title)}`;
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

/** Coerce one raw model item into a contract {@link ConventionFinding}, forcing
 *  `category` (the pass owns it, not the model) and assigning a stable id +
 *  fingerprint. Returns `undefined` when the item can't satisfy the schema. */
function coerceConventionFinding(
  raw: unknown,
  category: ConventionCategory,
): ConventionFinding | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  const title = getString(r, 'title');
  const description = getString(r, 'description');
  if (title === undefined || description === undefined) return undefined;

  const fingerprint = conventionFingerprint(category, title);
  const rationale = getString(r, 'rationale');
  const suggestion = getString(r, 'suggestion');
  const confidence = getNumber(r, 'confidence');

  const candidate: Record<string, unknown> = {
    id: `${category}-${fingerprint}`,
    category,
    kind: coerceKind(r.kind),
    severity: coerceSeverity(r.severity),
    title,
    description,
    ...(rationale !== undefined ? { rationale } : {}),
    evidence: coerceEvidence(r),
    ...(suggestion !== undefined ? { suggestion } : {}),
    tags: getStringArray(r, 'tags'),
    ...(confidence !== undefined ? { confidence } : {}),
    fingerprint,
  };

  const result = ConventionFindingSchema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

/** Collect the finding's file anchors. Accepts a `evidence` array OR a single
 *  `location`/`file` (the model sometimes reports one anchor inline). */
function coerceEvidence(r: Record<string, unknown>): FindingLocation[] {
  const out: FindingLocation[] = [];
  const rawEvidence = r.evidence;
  if (Array.isArray(rawEvidence)) {
    for (const entry of rawEvidence) {
      const loc = coerceLocation(entry);
      if (loc !== undefined) out.push(loc);
    }
  } else {
    const single = coerceLocation(r.location ?? r.file);
    if (single !== undefined) out.push(single);
  }
  return out;
}

/** A convention records an observed rule (`convention`) or a missing best
 *  practice (`gap`). Default to `gap` unless the model explicitly says otherwise. */
function coerceKind(raw: unknown): ConventionKind {
  return String(raw).toLowerCase() === 'convention' ? 'convention' : 'gap';
}

function coerceSeverity(raw: unknown): FindingSeverity {
  const v = String(raw).toLowerCase();
  if (v in SEVERITY_RANK) return v as FindingSeverity;
  // Map common synonyms onto the unified scale.
  if (v === 'warning' || v === 'minor' || v === 'suggestion') return 'low';
  if (v === 'major' || v === 'error') return 'high';
  return 'medium';
}

/**
 * Parse a convention pass's raw result text into validated findings. Tolerant:
 * malformed items are skipped, not fatal. Returns the parsed findings plus an
 * `error` when NO JSON could be extracted at all (so the orchestrator can mark
 * the lens errored vs legitimately empty).
 */
export function parseConventionFindings(
  raw: string,
  category: ConventionCategory,
): { findings: ConventionFinding[]; error?: string } {
  const parsed = extractJson(raw);
  if (parsed === undefined) {
    return { findings: [], error: 'no JSON convention findings in model output' };
  }
  const items = toRawArray(parsed);
  const findings: ConventionFinding[] = [];
  for (const item of items) {
    const finding = coerceConventionFinding(item, category);
    if (finding !== undefined) findings.push(finding);
  }
  return { findings };
}

/**
 * Ground convention findings against the real tree. Each finding's `evidence` is
 * filtered to anchors whose file exists & is contained under the project root, and
 * each anchor's line numbers are clamped to the real file length so the UI can
 * deep-link safely. UNLIKE Insight: a finding whose evidence is now EMPTY is KEPT
 * (conventions are legitimately repo-wide / fileless — "the repo uses a
 * folder-per-component layout" has no single line); only the hallucinated anchors
 * are dropped, never the finding.
 */
export function groundConventionFindings(
  findings: ConventionFinding[],
  projectPath: string,
): ConventionFinding[] {
  const grounded: ConventionFinding[] = [];
  for (const finding of findings) {
    const evidence: FindingLocation[] = [];
    for (const anchor of finding.evidence) {
      if (!fileExists(projectPath, anchor.file)) continue;
      const lines = lineCount(path.resolve(projectPath, anchor.file));
      evidence.push(clampLocationLines(anchor, lines));
    }
    grounded.push({ ...finding, evidence });
  }
  return grounded;
}

/**
 * Dedup convention findings by `fingerprint` (`category | title`): when two passes
 * surface the same convention, keep ONE — the higher-severity instance — and union
 * their tags. Order-stable on first appearance, mirroring `dedupeFindings`.
 */
export function dedupeConventionFindings(
  findings: ConventionFinding[],
): ConventionFinding[] {
  const byKey = new Map<string, ConventionFinding>();
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
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]
        ? finding
        : existing;
    const tags = [...new Set([...existing.tags, ...finding.tags])];
    byKey.set(key, { ...winner, tags });
  }
  return order.map((key) => byKey.get(key) as ConventionFinding);
}
