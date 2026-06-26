/**
 * Pure helpers for the Insight analysis pipeline — the parse → ground → dedup
 * steps that turn a category pass's free-text result into validated, grounded,
 * de-duplicated {@link Finding}s. Kept pure (only `fs`/`crypto`, no SDK, no
 * emitter) so every step is unit-testable in isolation. This is the production
 * answer to Aperant's fragile JSON-file round-trip: the engine validates the
 * model's output against the contract and verifies its file refs against the real
 * tree before anything is streamed to the UI.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FindingSchema,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
} from '@nightcore/contracts';
import { getNumber, getString, getStringArray } from './field-extract.js';

/** Severity ordering for ranking/merge (low → high). */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function severityRank(s: FindingSeverity): number {
  return SEVERITY_RANK[s];
}

/** Normalize a title for fingerprinting/dedup: lowercase, collapse whitespace. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Normalize a repo-relative path (strip leading `./`, backslashes → `/`). */
function normalizeFile(file: string | undefined): string {
  if (file === undefined) return '';
  return file.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/**
 * Stable content fingerprint for a finding: `file | title` — deliberately
 * CATEGORY-INDEPENDENT and line-independent. It is the same key used both to carry
 * dismissed-history across re-runs (Rust matches on it) AND to dedup across
 * category passes, so the two can never diverge. Category is excluded because the
 * cross-category dedup picks a winning category, which would otherwise mutate the
 * fingerprint between runs and resurrect a dismissed finding; line is excluded so a
 * one-line drift between runs doesn't break the dismissed match. Returns a short
 * hex digest.
 */
export function fingerprintOf(file: string | undefined, title: string): string {
  const basis = `${normalizeFile(file)}|${normalizeTitle(title)}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/**
 * Pull the first JSON array (or object) out of a model result that may be wrapped
 * in prose or ```json fences. Returns the parsed value, or `undefined` if no
 * valid JSON array/object can be located. Tolerant by design — the model is
 * instructed to return bare JSON but sometimes adds a sentence or a fence.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // 1) Whole string is JSON.
  const whole = tryParse(trimmed);
  if (whole !== undefined) return whole;
  // 2) Fenced ```json … ``` block.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1] !== undefined) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }
  // 3) First balanced [...] or {...} span.
  for (const [open, close] of [
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const span = tryParse(trimmed.slice(start, end + 1));
      if (span !== undefined) return span;
    }
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
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

/** Coerce one raw model item into a contract {@link Finding}, forcing `category`
 *  (the pass owns it, not the model) and assigning a stable id + fingerprint.
 *  Returns `undefined` when the item can't satisfy the schema. */
function coerceFinding(
  raw: unknown,
  category: FindingCategory,
): Finding | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  const title = getString(r, 'title');
  const description = getString(r, 'description');
  if (title === undefined || description === undefined) return undefined;

  // location may be a nested object or a "file:line" string.
  const location = coerceLocation(r.location ?? r.file);
  const file = location?.file;
  const fingerprint = fingerprintOf(file, title);

  const rationale = getString(r, 'rationale');
  const suggestion = getString(r, 'suggestion');
  const codeBefore = getString(r, 'codeBefore');
  const codeAfter = getString(r, 'codeAfter');
  const confidence = getNumber(r, 'confidence');

  const candidate: Record<string, unknown> = {
    id: `${category}-${fingerprint}`,
    category,
    severity: coerceSeverity(r.severity),
    effort: coerceEffort(r.effort),
    title,
    description,
    ...(rationale !== undefined ? { rationale } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(codeBefore !== undefined ? { codeBefore } : {}),
    ...(codeAfter !== undefined ? { codeAfter } : {}),
    affectedFiles: getStringArray(r, 'affectedFiles').map(normalizeFile),
    tags: getStringArray(r, 'tags'),
    ...(confidence !== undefined ? { confidence } : {}),
    fingerprint,
  };

  const result = FindingSchema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

function coerceLocation(raw: unknown): Finding['location'] {
  if (typeof raw === 'string') {
    // "src/foo.ts:42" or "src/foo.ts:42-50"
    const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(raw.trim());
    if (m) {
      return {
        file: normalizeFile(m[1]),
        startLine: Number(m[2]),
        ...(m[3] !== undefined ? { endLine: Number(m[3]) } : {}),
      };
    }
    return raw.trim().length > 0 ? { file: normalizeFile(raw) } : undefined;
  }
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const rawFile = getString(o, 'file');
    if (rawFile === undefined) return undefined;
    const startLine = getNumber(o, 'startLine') ?? getNumber(o, 'line');
    const endLine = getNumber(o, 'endLine');
    const symbol = getString(o, 'symbol');
    return {
      file: normalizeFile(rawFile),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(symbol !== undefined ? { symbol } : {}),
    };
  }
  return undefined;
}

function coerceSeverity(raw: unknown): FindingSeverity {
  const v = String(raw).toLowerCase();
  if (v in SEVERITY_RANK) return v as FindingSeverity;
  // Map common synonyms onto the unified scale.
  if (v === 'warning' || v === 'minor' || v === 'suggestion') return 'low';
  if (v === 'major' || v === 'error') return 'high';
  return 'medium';
}

function coerceEffort(raw: unknown): Finding['effort'] {
  const v = String(raw).toLowerCase();
  if (v === 'trivial' || v === 'small' || v === 'medium' || v === 'large') {
    return v;
  }
  if (v === 'easy' || v === 'quick') return 'small';
  if (v === 'hard' || v === 'complex' || v === 'xl') return 'large';
  return 'medium';
}

/**
 * Parse a category pass's raw result text into validated findings. Tolerant:
 * malformed items are skipped, not fatal. Returns the parsed findings plus an
 * `error` when NO JSON could be extracted at all (so the orchestrator can mark
 * the category errored vs legitimately empty).
 */
export function parseFindings(
  raw: string,
  category: FindingCategory,
): { findings: Finding[]; error?: string } {
  const parsed = extractJson(raw);
  if (parsed === undefined) {
    return { findings: [], error: 'no JSON findings array in model output' };
  }
  const items = toRawArray(parsed);
  const findings: Finding[] = [];
  for (const item of items) {
    const finding = coerceFinding(item, category);
    if (finding !== undefined) findings.push(finding);
  }
  return { findings };
}

/** Count lines in a file, cheaply. Returns 0 when unreadable. */
function lineCount(absPath: string): number {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    if (content.length === 0) return 0;
    let n = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** Whether a repo-relative path exists as a file under the project root, and is
 *  contained within it (no `../` escape). */
function fileExists(projectPath: string, rel: string): boolean {
  if (rel.length === 0) return false;
  const abs = path.resolve(projectPath, rel);
  const root = path.resolve(projectPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Ground findings against the real tree. A finding whose `location.file` does not
 * exist is treated as hallucinated and DROPPED (the core fix over Aperant, which
 * shows fabricated file refs). A finding with no location is kept (repo-level
 * findings — architecture, dependencies — are legitimately fileless), but its
 * `affectedFiles` is filtered to existing paths and its line numbers are clamped
 * to the real file length so the UI can deep-link safely.
 */
export function groundFindings(
  findings: Finding[],
  projectPath: string,
): Finding[] {
  const grounded: Finding[] = [];
  for (const finding of findings) {
    const loc = finding.location;
    if (loc !== undefined) {
      if (!fileExists(projectPath, loc.file)) {
        // Hallucinated file ref — drop the finding entirely.
        continue;
      }
      const lines = lineCount(path.resolve(projectPath, loc.file));
      const clampedLoc = clampLocationLines(loc, lines);
      grounded.push({
        ...finding,
        location: clampedLoc,
        affectedFiles: finding.affectedFiles.filter((f) =>
          fileExists(projectPath, f),
        ),
      });
    } else {
      grounded.push({
        ...finding,
        affectedFiles: finding.affectedFiles.filter((f) =>
          fileExists(projectPath, f),
        ),
      });
    }
  }
  return grounded;
}

function clampLocationLines(
  loc: NonNullable<Finding['location']>,
  lines: number,
): NonNullable<Finding['location']> {
  // Clamp to a floor of 1: an empty or unreadable file (lineCount → 0) still has a
  // valid line 1 to deep-link to, so out-of-range refs collapse to 1 rather than
  // surviving past the real file length.
  const max = Math.max(lines, 1);
  const clamp = (n: number | undefined): number | undefined =>
    n === undefined ? undefined : Math.min(Math.max(1, n), max);
  const startLine = clamp(loc.startLine);
  let endLine = clamp(loc.endLine);
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    endLine = startLine;
  }
  return {
    ...loc,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

/**
 * Cross-category dedup: when two passes surface the same issue, keep ONE — the
 * higher-severity instance — and union their tags. The dedup key IS the
 * `fingerprint` (`file | title`), so it can never diverge from the dismissed-history
 * key: a finding the user dismissed in a prior run matches the same survivor here.
 * The survivor's category is the higher-severity one's; the fingerprint is stable
 * regardless of which category wins. Order-stable on first appearance.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
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
      severityRank(finding.severity) > severityRank(existing.severity)
        ? finding
        : existing;
    const tags = [...new Set([...existing.tags, ...finding.tags])];
    byKey.set(key, { ...winner, tags });
  }
  return order.map((key) => byKey.get(key) as Finding);
}
