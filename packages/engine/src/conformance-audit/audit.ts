/**
 * The DEEP CONFORMANCE AUDIT pass (issue #279) — the opt-in, expensive half of drift.
 *
 * Drift v1 measures conformance MECHANICALLY (an armed lint-meta / ESLint check, run
 * and counted). That leaves every convention no deterministic check can express sitting
 * honestly at `uncheckable`. This pass answers those, and only those, by having the
 * model RE-READ the sites — the path the drift spec priced at $30–95/run when applied
 * to everything, which is exactly why it is opt-in, capped by the caller, and bounded
 * by a turn/budget ceiling here.
 *
 * ## Honesty rules (the same ones the mechanical substrates obey)
 *
 *  - **Grounded fingerprints only.** A returned record whose `conventionFingerprint`
 *    was not in the request is DROPPED. The model cannot introduce a convention.
 *  - **No `clean` without a count.** A verdict with `sitesChecked <= 0` is rewritten to
 *    `errored`, because a model that read nothing has established nothing. So is a
 *    `drifted` verdict claiming zero violating sites.
 *  - **Silence is `errored`, not `clean`.** A requested convention the model omitted
 *    comes back as an `errored` record saying so, never as a pass.
 *  - **`method` names the judge.** Every record carries `deep-audit: <model>` so a
 *    reader can always tell a MEASURED count from a MODEL-JUDGED one — including the
 *    carry-forward comparability basis, which therefore never diffs a deep run against
 *    a shallow one.
 *
 * Fail-SOFT like the RuleTester runner: a failed/cancelled/unparseable pass returns
 * `error` plus `errored` records for everything requested, never a throw.
 */
import type {
  Config,
  ConformanceAuditResult,
  ConformanceAuditTarget,
  ConventionDrift,
  SurfaceQuery,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type { ScanRunnerFactory } from '../scans/shared/runner-factory.js';
import { runTailSession } from '../scans/shared/tail-session.js';
import { getString } from '../util/field-extract.js';
import { extractJson, toRawArray } from '../util/json-extract.js';

type AuditConformance = Extract<SurfaceQuery, { type: 'audit-conformance' }>;

/** Hard cap on conventions per pass, independent of what the caller asked for: the
 *  prompt has to carry each convention AND the model has to read real sites for each,
 *  so an unbounded list is how this pass becomes the $95 run it was designed to avoid. */
export const MAX_AUDITED_CONVENTIONS = 12;

/** Turn ceiling when the request names none. Generous enough to grep + read a handful
 *  of files per convention, bounded enough that a wandering pass terminates. */
export const DEFAULT_AUDIT_MAX_TURNS = 30;

/** Read-only toolset: the pass must be able to search and read the repo, and must not
 *  be able to change it. Mirrors the harness analysis preset's posture. */
const AUDIT_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const;
const AUDIT_DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
] as const;

const AUDIT_PERSONA = [
  'You are AUDITING whether specific, already-identified conventions are actually',
  'FOLLOWED at every site in this repository. You never write or edit files — you read',
  'and search, then report counts. You are measuring conformance, not proposing work.',
].join(' ');

const RETRY_REMINDER =
  '\n\nReturn ONLY the JSON array described above — no prose, no markdown fences.';

/** Statuses this pass may assign. `uncheckable` is deliberately absent: a convention
 *  reaching the deep audit is BY DEFINITION one no mechanical check covers, so
 *  repeating that would be a non-answer. */
const CLEAN = 'clean';
const DRIFTED = 'drifted';
const ERRORED = 'errored';

export interface RunConformanceAuditArgs {
  query: AuditConformance;
  config: Config;
  apiKeyFallback: boolean;
  runnerFactory: ScanRunnerFactory;
  logger?: Logger;
}

/** Build the audit prompt: the conventions to check, and the exact output contract. */
export function buildAuditPrompt(
  projectPath: string,
  conventions: readonly ConformanceAuditTarget[],
): string {
  return [
    `Audit the repository at: ${projectPath}`,
    '',
    'For EACH convention below, determine whether the codebase actually follows it.',
    'Search for the sites the convention applies to, READ enough of them to judge, and',
    'report how many you examined and how many VIOLATE the convention.',
    '',
    'CONVENTIONS TO AUDIT:',
    ...conventions.map(
      (c) =>
        `- (${c.fingerprint}) [${c.category}] ${c.title}${
          c.description !== '' ? ` — ${c.description}` : ''
        }`,
    ),
    '',
    'Return ONLY a JSON array (no prose, no markdown fences), one entry per convention:',
    '{',
    '  "fingerprint": "the EXACT fingerprint from the list above",',
    '  "status": "clean | drifted | errored",',
    '  "sitesChecked": <how many sites you actually examined — an integer > 0>,',
    '  "sitesMatched": <how many of those VIOLATE the convention>,',
    '  "note": "one line: what you looked at, or why you could not judge"',
    '}',
    '',
    'RULES — these are not negotiable:',
    '  - NEVER report `clean` unless you actually examined sites: `sitesChecked` must be',
    '    the real number you looked at, and `sitesMatched` must be 0.',
    '  - `drifted` means `sitesMatched` > 0. Report the real count.',
    '  - If you could not find the sites, or cannot judge the convention by reading,',
    '    return `errored` with a `note` explaining why. That is a CORRECT answer.',
    '    Guessing a `clean` is not.',
    '  - Report on every fingerprint above, exactly once, and invent no others.',
  ].join('\n');
}

/** One parsed verdict, before grounding. */
interface RawVerdict {
  fingerprint: string;
  status: string;
  sitesChecked: number;
  sitesMatched: number;
  note?: string;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** Parse the model's array into raw verdicts. Returns `undefined` when nothing
 *  array-shaped came back (which drives the one corrective retry). */
export function parseAuditVerdicts(raw: string): RawVerdict[] | undefined {
  const json = extractJson(raw);
  if (json === undefined || json === null) return undefined;
  const items = toRawArray(json, 'audited');
  if (items.length === 0 && !Array.isArray(json)) return undefined;
  return items.flatMap((item) => {
    const record = item as Record<string, unknown>;
    const fingerprint = getString(record, 'fingerprint');
    if (fingerprint === undefined) return [];
    const note = getString(record, 'note');
    return [
      {
        fingerprint,
        status: getString(record, 'status') ?? ERRORED,
        sitesChecked: toNumber(record.sitesChecked),
        sitesMatched: toNumber(record.sitesMatched),
        ...(note !== undefined ? { note } : {}),
      },
    ];
  });
}

function driftRecord(
  target: ConformanceAuditTarget,
  method: string,
  fields: Pick<ConventionDrift, 'status' | 'sitesChecked' | 'sitesMatched'> & {
    errorReason?: string;
  },
): ConventionDrift {
  return {
    id: `drift-${target.fingerprint}`,
    conventionFingerprint: target.fingerprint,
    category: target.category,
    title: target.title,
    status: fields.status,
    method,
    sitesMatched: fields.sitesMatched,
    sitesChecked: fields.sitesChecked,
    ...(fields.errorReason !== undefined ? { errorReason: fields.errorReason } : {}),
    fingerprint: target.fingerprint,
  };
}

/**
 * Ground the model's verdicts against the REQUESTED conventions, applying the honesty
 * rules. Pure, so every rule is unit-testable without a session. Always returns exactly
 * one record per requested convention, in request order.
 */
export function groundAuditVerdicts(
  conventions: readonly ConformanceAuditTarget[],
  verdicts: readonly RawVerdict[],
  model: string,
): ConventionDrift[] {
  const method = `deep-audit: ${model}`;
  // Last verdict wins for a duplicated fingerprint; an unrequested one is dropped here
  // simply by never being looked up.
  const byFingerprint = new Map(verdicts.map((v) => [v.fingerprint, v]));
  return conventions.map((target) => {
    const verdict = byFingerprint.get(target.fingerprint);
    if (verdict === undefined) {
      return driftRecord(target, method, {
        status: ERRORED,
        sitesChecked: 0,
        sitesMatched: 0,
        errorReason: 'the deep audit returned no verdict for this convention',
      });
    }
    if (verdict.status === ERRORED) {
      return driftRecord(target, method, {
        status: ERRORED,
        sitesChecked: 0,
        sitesMatched: 0,
        errorReason: verdict.note ?? 'the deep audit could not judge this convention',
      });
    }
    // A judgement with no examined sites established nothing — fail-visible.
    if (verdict.sitesChecked <= 0) {
      return driftRecord(target, method, {
        status: ERRORED,
        sitesChecked: 0,
        sitesMatched: 0,
        errorReason:
          'the deep audit reported a verdict without examining any site, so this ' +
          "convention's conformance was not established",
      });
    }
    const matched = Math.min(verdict.sitesMatched, verdict.sitesChecked);
    if (verdict.status === DRIFTED && matched === 0) {
      return driftRecord(target, method, {
        status: ERRORED,
        sitesChecked: 0,
        sitesMatched: 0,
        errorReason: 'the deep audit reported drift but no violating site',
      });
    }
    if (verdict.status !== CLEAN && verdict.status !== DRIFTED) {
      return driftRecord(target, method, {
        status: ERRORED,
        sitesChecked: 0,
        sitesMatched: 0,
        errorReason: `the deep audit returned an unknown status \`${verdict.status}\``,
      });
    }
    return driftRecord(target, method, {
      status: matched === 0 ? CLEAN : DRIFTED,
      sitesChecked: verdict.sitesChecked,
      sitesMatched: matched,
    });
  });
}

/** Every requested convention as an `errored` record — the shape a degraded pass
 *  returns, so the panel shows "the audit could not measure this", never silence. */
function allErrored(
  conventions: readonly ConformanceAuditTarget[],
  model: string,
  reason: string,
): ConventionDrift[] {
  return groundAuditVerdicts(conventions, [], model).map((d) => ({
    ...d,
    errorReason: reason,
  }));
}

/**
 * Run the deep conformance audit for one `audit-conformance` query. NEVER throws:
 * every degraded path returns `error` alongside `errored` records for the requested
 * conventions.
 */
export async function runConformanceAudit(
  args: RunConformanceAuditArgs,
): Promise<ConformanceAuditResult> {
  const { query, logger } = args;
  const model = query.model ?? args.config.model;
  const conventions = query.conventions.slice(0, MAX_AUDITED_CONVENTIONS);
  if (conventions.length === 0) {
    return { drift: [], model, costUsd: 0 };
  }

  const tail = await runTailSession<RawVerdict[]>({
    prompt: buildAuditPrompt(query.projectPath, conventions),
    persona: AUDIT_PERSONA,
    tools: { allowed: AUDIT_ALLOWED_TOOLS, disallowed: AUDIT_DISALLOWED_TOOLS },
    command: {
      runId: query.requestId,
      projectPath: query.projectPath,
      ...(query.model !== undefined ? { model: query.model } : {}),
    },
    config: args.config,
    apiKeyFallback: args.apiKeyFallback,
    ...(logger !== undefined ? { logger } : {}),
    runnerFactory: args.runnerFactory,
    label: 'harness:deep-audit',
    retryReminder: RETRY_REMINDER,
    parse: (raw) => {
      const verdicts = parseAuditVerdicts(raw);
      return verdicts === undefined
        ? { error: 'the deep audit did not return a JSON array' }
        : { value: verdicts };
    },
    maxTurns: query.maxTurns ?? DEFAULT_AUDIT_MAX_TURNS,
    ...(query.maxBudgetUsd !== undefined ? { maxBudgetUsd: query.maxBudgetUsd } : {}),
  });

  if (tail.value === undefined) {
    const reason = tail.error ?? 'the deep audit produced no result';
    logger?.warn('deep conformance audit degraded', { error: reason });
    return {
      drift: allErrored(conventions, model, reason),
      model,
      costUsd: tail.costUsd,
      error: reason,
    };
  }

  return {
    drift: groundAuditVerdicts(conventions, tail.value, model),
    model,
    costUsd: tail.costUsd,
    ...(tail.error !== undefined ? { error: tail.error } : {}),
  };
}
