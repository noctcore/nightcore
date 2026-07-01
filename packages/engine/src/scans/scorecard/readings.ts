/**
 * Pure helpers for the Readiness Scorecard pipeline — the parse → ground steps that
 * turn a dimension pass's free-text result into a single validated, grounded
 * {@link ScorecardReading}. Kept pure (only `fs`/`crypto`, no SDK, no emitter) so
 * every step is unit-testable in isolation. Mirrors `analysis-findings.ts`, reusing
 * {@link extractJson} + {@link fingerprintOf} VERBATIM (imported, not re-declared)
 * so the JSON extraction and fingerprint key can never diverge from Insight's.
 */
import * as path from 'node:path';
import {
  ScorecardReadingSchema,
  type ScorecardDimension,
  type ScorecardEvidence,
  type ScorecardGrade,
  type ScorecardReading,
} from '@nightcore/contracts';
import {
  clampLocationLines,
  coerceLocation,
  extractJson,
  fileExists,
  fingerprintOf,
  lineCount,
  normalizeFile,
} from '../shared/findings.js';
import { getNumber, getString, getStringArray } from '../../util/field-extract.js';

/** The valid grade letters. */
const GRADES: readonly ScorecardGrade[] = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Validate a raw grade to a canonical letter, or `undefined` when the model returns
 *  something off-scale (`"B+"`, `"PASS"`, `"N/A"`, `"great"`). We deliberately do NOT
 *  coerce an unknown value to a neutral `C`: that fabricates a grade the model never
 *  gave and silently inflates/deflates the headline. The caller treats `undefined` as
 *  a parse error so the pass's corrective retry re-asks; a dimension still ungradeable
 *  after the retry is surfaced errored, not faked. Case/whitespace are tolerated. */
function validGrade(raw: unknown): ScorecardGrade | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toUpperCase();
  return (GRADES as readonly string[]).includes(v) ? (v as ScorecardGrade) : undefined;
}

/** Coerce one raw evidence item into a contract {@link ScorecardEvidence}. Returns
 *  `undefined` when it has no `detail`. */
function coerceEvidence(raw: unknown): ScorecardEvidence | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const detail = getString(r, 'detail') ?? getString(r, 'description');
  if (detail === undefined) return undefined;
  const location = coerceLocation(r.location ?? r.file);
  return { detail, ...(location !== undefined ? { location } : {}) };
}

/** Pull the evidence array out of a raw reading object (`findings` or `evidence`). */
function evidenceArray(r: Record<string, unknown>): unknown[] {
  const f = r.findings ?? r.evidence;
  return Array.isArray(f) ? f : [];
}

/**
 * Parse a dimension pass's raw result text into ONE validated {@link ScorecardReading},
 * forcing `dimension` (the pass owns it, not the model) and assigning a stable id +
 * fingerprint. Tolerant: a malformed evidence item is skipped, not fatal. Returns
 * `{ reading }` on success or `{ error }` when no JSON object could be extracted at
 * all (so the orchestrator can mark the dimension errored vs legitimately ungraded).
 */
export function parseReading(
  raw: string,
  dimension: ScorecardDimension,
): { reading?: ScorecardReading; error?: string } {
  const parsed = extractJson(raw);
  if (parsed === undefined) {
    return { error: 'no JSON reading object in model output' };
  }
  // The model is asked for a single object; tolerate a one-element array wrapper.
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (obj === null || typeof obj !== 'object') {
    return { error: 'model output was not a reading object' };
  }
  const r = obj as Record<string, unknown>;

  const title = getString(r, 'title');
  const summary = getString(r, 'summary') ?? getString(r, 'description');
  if (title === undefined || summary === undefined) {
    return { error: 'reading missing title/summary' };
  }

  // A grade the model returns off-scale must NOT be silently coerced to a neutral 'C'
  // — that manufactures a grade it never gave. Error out so the corrective retry fires.
  const grade = validGrade(r.grade);
  if (grade === undefined) {
    return { error: `reading has no valid grade (got ${JSON.stringify(r.grade)})` };
  }

  const fingerprint = fingerprintOf(dimension, title);
  const location = coerceLocation(r.location ?? r.file);
  const findings: ScorecardEvidence[] = [];
  for (const item of evidenceArray(r)) {
    const ev = coerceEvidence(item);
    if (ev !== undefined) findings.push(ev);
  }

  const rationale = getString(r, 'rationale');
  const suggestion = getString(r, 'suggestion');
  const confidence = getNumber(r, 'confidence');

  const candidate: Record<string, unknown> = {
    id: `${dimension}-${fingerprint}`,
    dimension,
    grade,
    title,
    summary,
    ...(rationale !== undefined ? { rationale } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    affectedFiles: getStringArray(r, 'affectedFiles').map(normalizeFile),
    tags: getStringArray(r, 'tags'),
    findings,
    ...(confidence !== undefined ? { confidence } : {}),
    fingerprint,
  };

  const result = ScorecardReadingSchema.safeParse(candidate);
  return result.success ? { reading: result.data } : { error: 'reading failed schema validation' };
}

/** Ground + clamp a reading/evidence location: drop it when the file does not exist
 *  (or escapes the root), otherwise clamp its line range to the real file length via
 *  the shared {@link clampLocationLines}. Unlike Insight's `groundFindings`, a missing
 *  file strips the location rather than dropping the whole reading. */
function clampLocation(
  projectPath: string,
  loc: NonNullable<ScorecardReading['location']>,
): NonNullable<ScorecardReading['location']> | undefined {
  if (!fileExists(projectPath, loc.file)) return undefined;
  const lines = lineCount(path.resolve(projectPath, loc.file));
  return clampLocationLines(loc, lines);
}

/**
 * Ground a reading against the real tree. Unlike `groundFindings` (which DROPS a
 * finding whose location is hallucinated), a reading is NEVER dropped — every
 * graded dimension must survive — so a hallucinated `location` is stripped to
 * fileless, `affectedFiles` is filtered to existing paths, line numbers are clamped
 * to the real file length, and each evidence item's location is grounded the same
 * way (stripped when its file does not exist). This is the production fix over a
 * model that deep-links to files it never read.
 */
export function groundReading(
  reading: ScorecardReading,
  projectPath: string,
): ScorecardReading {
  const location =
    reading.location !== undefined
      ? clampLocation(projectPath, reading.location)
      : undefined;
  const findings: ScorecardEvidence[] = reading.findings.map((ev) => {
    const loc =
      ev.location !== undefined
        ? clampLocation(projectPath, ev.location)
        : undefined;
    return { detail: ev.detail, ...(loc !== undefined ? { location: loc } : {}) };
  });
  return {
    ...reading,
    ...(location !== undefined ? { location } : { location: undefined }),
    affectedFiles: reading.affectedFiles.filter((f) => fileExists(projectPath, f)),
    findings,
  };
}
