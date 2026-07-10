/**
 * The Harness ENFORCE-lite coverage join — turns the deduped convention findings
 * plus the deterministic rule {@link RuleInventory} into one {@link RuleCoverageGap}
 * per convention: `enforced` (a lint/meta/gauntlet rule covers it) / `documented-only`
 * (an agent doc claims it, no rule) / `unenforced` (neither).
 *
 * Two stages, cheapest-first (memo Variant 1, `2026-07-10-enforce-capability-design.md`
 * §2b/§4):
 *   1. A DETERMINISTIC pre-match short-circuits the obvious pairs — a convention whose
 *      tags/title strongly overlap an inventory rule id is `enforced` with no LLM.
 *   2. The residue goes to ONE no-tool `runTailSession` (the synthesis seam,
 *      `tail-session.ts`) given the inventory + the unmatched conventions in the
 *      prompt — a pure completion, no repo tools, ~$0.10–0.50, run in `finalize`.
 * When the inventory is empty (no rule enforces anything) OR there are no findings,
 * the whole pass is deterministic and free.
 *
 * Coverage is a BONUS signal: unlike synthesis it FAILS OPEN — a crashed/failed join
 * degrades every unclassified convention to `unenforced` (+ an `error` the caller logs)
 * rather than throwing, so a coverage hiccup never fails a scan that has real findings.
 * "Coverage, not conformance": a record never claims a convention is FOLLOWED at every
 * site — that is Phase-2 drift.
 */
import type {
  Config,
  ConventionFinding,
  CoverageStatus,
  RuleCoverageGap,
  SurfaceCommand,
  TokenUsage,
} from '@nightcore/contracts';
import { CoverageStatusSchema, RuleCoverageGapSchema } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { getString, getStringArray } from '../../util/field-extract.js';
import { extractJson, toRawArray } from '../../util/json-extract.js';
import type {
  ScanRunnerFactory,
  ScanSessionRunner,
} from '../shared/scan-manager.js';
import { EMPTY_USAGE } from '../shared/scan-manager.js';
import { runTailSession } from '../shared/tail-session.js';
import type { RuleInventory } from './inventory.js';
import { ANALYSIS_ALLOWED_TOOLS, ANALYSIS_DISALLOWED_TOOLS } from './presets.js';

type StartHarnessScan = Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

/** Stop-tokens that carry no matching signal (every convention title has them). */
const STOP_TOKENS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'be', 'use', 'used', 'uses', 'each', 'every', 'all', 'no', 'not',
  'rule', 'rules', 'convention', 'conventions', 'must', 'should', 'per',
]);

export interface ComputeCoverageArgs {
  /** The deduped convention findings coverage is computed for (one record each). */
  findings: ConventionFinding[];
  /** The deterministic enforcement inventory (from `extractRuleInventory`). */
  inventory: RuleInventory;
  command: StartHarnessScan;
  config: Config;
  apiKeyFallback: boolean;
  logger?: Logger;
  runnerFactory: ScanRunnerFactory;
  /** Live-runner registry so a `cancel()` interrupts the coverage session too. */
  runners?: Set<ScanSessionRunner>;
  isCancelled?: () => boolean;
}

export interface ComputeCoverageResult {
  coverage: RuleCoverageGap[];
  usage: TokenUsage;
  costUsd: number;
  /** Set when the join failed/degraded (logged by the caller; scan still completes). */
  error?: string;
}

/** The no-tool coverage persona — a pure reasoning pass over the inventory + findings
 *  already in the prompt. The literal "COVERAGE" lets a test fake route this session
 *  distinctly from a lens / the synthesis pass. */
const COVERAGE_PERSONA = [
  'You are auditing ENFORCEMENT COVERAGE: for each observed convention, decide whether',
  'the repo already ENFORCES it with a lint/meta/gauntlet rule (enforced), only CLAIMS it',
  'in an agent doc with no rule (documented-only), or neither (unenforced). This is',
  'COVERAGE, not conformance — never claim a convention is FOLLOWED at every site.',
  'You have NO tools; reason only from the inventory and conventions given in the prompt.',
].join(' ');

const COVERAGE_RETRY_REMINDER =
  '\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON object { "coverage": [...] }, nothing else.';

/**
 * Compute per-convention coverage. Deterministic pre-match first, then one no-tool
 * LLM join for the residue; every convention gets exactly one grounded record.
 * Never throws (fail-open).
 */
export async function computeCoverage(
  args: ComputeCoverageArgs,
): Promise<ComputeCoverageResult> {
  const { findings, inventory } = args;
  if (findings.length === 0) {
    return { coverage: [], usage: { ...EMPTY_USAGE }, costUsd: 0 };
  }

  // Stage 1 — deterministic pre-match: an obvious rule↔convention pair is `enforced`
  // with no LLM. Everything else is a candidate for the join.
  const records = new Map<string, RuleCoverageGap>();
  const residue: ConventionFinding[] = [];
  for (const finding of findings) {
    const rule = preMatchRule(finding, inventory.ruleIds);
    if (rule !== undefined) {
      records.set(finding.fingerprint, record(finding, 'enforced', [rule], []));
    } else {
      residue.push(finding);
    }
  }

  // Nothing left to reason about, OR the repo enforces/documents nothing at all →
  // the residue is deterministically `unenforced`; skip the (paid) join entirely.
  const noSignal = inventory.ruleIds.length === 0 && inventory.docClaims.length === 0;
  if (residue.length === 0 || noSignal) {
    for (const finding of residue) {
      records.set(finding.fingerprint, record(finding, 'unenforced', [], []));
    }
    return {
      coverage: orderCoverage(findings, records),
      usage: { ...EMPTY_USAGE },
      costUsd: 0,
    };
  }

  // Stage 2 — the no-tool join over the residue.
  const tail = await runTailSession<Map<string, RuleCoverageGap>>({
    prompt: buildCoveragePrompt(residue, inventory),
    persona: COVERAGE_PERSONA,
    // No-tool: deny even the read tools so it can't explore the repo — everything it
    // needs is in the prompt, keeping the pass a cheap pure completion.
    tools: {
      allowed: [],
      disallowed: [...ANALYSIS_ALLOWED_TOOLS, ...ANALYSIS_DISALLOWED_TOOLS],
    },
    command: args.command,
    config: args.config,
    apiKeyFallback: args.apiKeyFallback,
    ...(args.logger !== undefined ? { logger: args.logger } : {}),
    runnerFactory: args.runnerFactory,
    ...(args.runners !== undefined ? { runners: args.runners } : {}),
    ...(args.isCancelled !== undefined ? { isCancelled: args.isCancelled } : {}),
    label: 'harness:coverage',
    retryReminder: COVERAGE_RETRY_REMINDER,
    parse: (raw) => {
      const parsed = parseCoverage(raw, residue, inventory);
      return {
        value: parsed.records,
        ...(parsed.error !== undefined ? { error: parsed.error } : {}),
      };
    },
    ...(args.command.maxTurnsPerCategory !== undefined
      ? { maxTurns: args.command.maxTurnsPerCategory }
      : {}),
    ...(args.command.maxBudgetUsdPerCategory !== undefined
      ? { maxBudgetUsd: args.command.maxBudgetUsdPerCategory }
      : {}),
  });

  // Merge the join's verdicts; any residue the model didn't (or couldn't) classify
  // defaults to `unenforced` — never left without a record. FAIL-OPEN: a crash/error
  // degrades the residue to `unenforced` too, never throwing.
  const joined = tail.value ?? new Map<string, RuleCoverageGap>();
  for (const finding of residue) {
    records.set(
      finding.fingerprint,
      joined.get(finding.fingerprint) ?? record(finding, 'unenforced', [], []),
    );
  }

  return {
    coverage: orderCoverage(findings, records),
    usage: tail.usage,
    costUsd: tail.costUsd,
    ...(tail.error !== undefined ? { error: tail.error } : {}),
  };
}

/**
 * Deterministically match a convention to an enforcing rule id by strong token
 * overlap — its tags first (the highest-signal, e.g. `folder-per-component`), then
 * its title. Returns the matched rule id or `undefined`. Conservative by design (a
 * wrong `enforced` is worse than deferring to the join): a match needs the rule id's
 * base (after the plugin scope) to share ≥2 significant tokens with the convention.
 */
export function preMatchRule(
  finding: ConventionFinding,
  ruleIds: string[],
): string | undefined {
  const conventionTokens = new Set<string>([
    ...finding.tags.flatMap(tokenize),
    ...tokenize(finding.title),
  ]);
  if (conventionTokens.size === 0) return undefined;
  for (const ruleId of ruleIds) {
    const ruleTokens = tokenize(ruleBase(ruleId));
    if (ruleTokens.length === 0) continue;
    const shared = ruleTokens.filter((t) => conventionTokens.has(t));
    // A strong (≥2 significant-token) overlap only — a single shared token is too
    // weak (a generic word would falsely mark a convention `enforced`); those
    // deferred to the LLM join, which is precision's job.
    if (shared.length >= 2) return ruleId;
  }
  return undefined;
}

/** A rule id's meaningful base: drop the plugin scope (`nightcore/x` → `x`,
 *  `@ts/eslint/x` → `x`). */
function ruleBase(ruleId: string): string {
  const parts = ruleId.split('/');
  return parts[parts.length - 1] ?? ruleId;
}

/** Lowercase significant tokens (≥3 chars, non stop-word) of a string. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

/** Build one grounded coverage record for a convention. */
function record(
  finding: ConventionFinding,
  status: CoverageStatus,
  enforcedBy: string[],
  documentedIn: string[],
): RuleCoverageGap {
  return RuleCoverageGapSchema.parse({
    id: `coverage-${finding.fingerprint}`,
    conventionFingerprint: finding.fingerprint,
    category: finding.category,
    title: finding.title,
    status,
    enforcedBy,
    documentedIn,
    fingerprint: finding.fingerprint,
  });
}

/** Coverage in the findings' order (stable UI), one record per convention. */
function orderCoverage(
  findings: ConventionFinding[],
  records: Map<string, RuleCoverageGap>,
): RuleCoverageGap[] {
  const out: RuleCoverageGap[] = [];
  for (const finding of findings) {
    const r = records.get(finding.fingerprint);
    if (r !== undefined) out.push(r);
  }
  return out;
}

/** The no-tool join prompt: the inventory + the unmatched conventions + the exact
 *  output contract. Everything the pass needs is inline (it has no tools). */
function buildCoveragePrompt(
  residue: ConventionFinding[],
  inventory: RuleInventory,
): string {
  return [
    'You are auditing ENFORCEMENT COVERAGE for a codebase. You are given the repo’s',
    'existing enforcement inventory and a list of observed conventions. For EACH',
    'convention, decide its coverage status. Do not run tools; reason only from below.',
    '',
    `ENFORCING RULE IDS (lint/meta/gauntlet rules wired at error|warn — ${inventory.ruleIds.length} total):`,
    inventory.ruleIds.length > 0 ? inventory.ruleIds.map((r) => `- ${r}`).join('\n') : '- (none)',
    '',
    'AGENT-DOC CLAIMS (guardrails written in CLAUDE.md / AGENTS.md — a claim without a',
    'matching rule above means the convention is DOCUMENTED-ONLY):',
    inventory.docClaims.length > 0 ? inventory.docClaims.map((c) => `- ${c}`).join('\n') : '- (none)',
    '',
    'CONVENTIONS to classify (reference each by its fingerprint):',
    residue
      .map((f) => {
        const tail = f.suggestion !== undefined ? ` → ${f.suggestion}` : '';
        const tags = f.tags.length > 0 ? ` [tags: ${f.tags.join(', ')}]` : '';
        return `- (${f.fingerprint}) [${f.category}] ${f.title}${tags}${tail}`;
      })
      .join('\n'),
    '',
    coverageOutputContract(),
  ].join('\n');
}

/** The JSON output contract for the coverage join. */
function coverageOutputContract(): string {
  return [
    'Return your whole answer as a JSON OBJECT (no prose, no markdown fences):',
    '{ "coverage": [ …one entry per convention above… ] }',
    'Each entry is:',
    '{',
    '  "conventionFingerprint": "the fingerprint in parentheses above",',
    '  "status": "enforced | documented-only | unenforced",',
    '  "enforcedBy": ["rule ids from the ENFORCING RULE IDS list that cover it"]  // REQUIRED for enforced,',
    '  "documentedIn": ["the agent-doc claim text that mentions it"]  // for documented-only,',
    '  "suggestedArtifactKind": "lint-meta-rule | eslint-rule | agent-contract | tool-config"  // what PROPOSE could generate to close the gap (optional)',
    '}',
    'Use `enforcedBy` ONLY with ids that appear VERBATIM in the ENFORCING RULE IDS list',
    '— never invent a rule id. `enforced` REQUIRES a non-empty `enforcedBy`. If a',
    'convention is only claimed in a doc with no matching rule, it is `documented-only`.',
    'If neither a rule nor a doc covers it, it is `unenforced`. Classify EVERY convention.',
  ].join('\n');
}

interface ParsedCoverage {
  records: Map<string, RuleCoverageGap>;
  /** Set only when NO JSON could be extracted at all (drives the one corrective retry). */
  error?: string;
}

/**
 * Parse + GROUND a coverage join answer into records keyed by conventionFingerprint.
 * Tolerant of the `{ coverage: [...] }` envelope and a bare array. GROUNDING keeps the
 * join honest: an entry's `enforcedBy` is filtered to ids that actually exist in the
 * inventory (a hallucinated rule id is dropped), and an `enforced` verdict with no
 * surviving rule id is downgraded (`documented-only` if it cites a doc, else
 * `unenforced`). Only conventions in `residue` are accepted (an entry for an unknown
 * fingerprint is ignored). Returns `error` only when no JSON is present at all.
 */
export function parseCoverage(
  raw: string,
  residue: ConventionFinding[],
  inventory: RuleInventory,
): ParsedCoverage {
  const parsed = extractJson(raw);
  if (parsed === undefined) {
    return { records: new Map(), error: 'no JSON in coverage output' };
  }
  const byFingerprint = new Map<string, ConventionFinding>();
  for (const f of residue) byFingerprint.set(f.fingerprint, f);
  const knownRules = new Set(inventory.ruleIds);

  const records = new Map<string, RuleCoverageGap>();
  for (const item of toRawArray(parsed, 'coverage')) {
    const gap = coerceCoverage(item, byFingerprint, knownRules);
    if (gap !== undefined) records.set(gap.conventionFingerprint, gap);
  }
  return { records };
}

/** Coerce + ground one raw model coverage item into a {@link RuleCoverageGap}, or drop it. */
function coerceCoverage(
  raw: unknown,
  byFingerprint: Map<string, ConventionFinding>,
  knownRules: Set<string>,
): RuleCoverageGap | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  const fingerprint = getString(r, 'conventionFingerprint');
  if (fingerprint === undefined) return undefined;
  const finding = byFingerprint.get(fingerprint);
  if (finding === undefined) return undefined;

  const statusResult = CoverageStatusSchema.safeParse(r.status);
  let status: CoverageStatus = statusResult.success ? statusResult.data : 'unenforced';

  // Ground `enforcedBy` to real inventory rule ids (drop hallucinations).
  const enforcedBy = getStringArray(r, 'enforcedBy').filter((id) => knownRules.has(id));
  const documentedIn = getStringArray(r, 'documentedIn');
  const suggestedArtifactKind = getString(r, 'suggestedArtifactKind');

  // Honesty guard: `enforced` with no surviving rule id can't stand.
  if (status === 'enforced' && enforcedBy.length === 0) {
    status = documentedIn.length > 0 ? 'documented-only' : 'unenforced';
  }

  const result = RuleCoverageGapSchema.safeParse({
    id: `coverage-${finding.fingerprint}`,
    conventionFingerprint: finding.fingerprint,
    category: finding.category,
    title: finding.title,
    status,
    enforcedBy,
    documentedIn,
    ...(suggestedArtifactKind !== undefined ? { suggestedArtifactKind } : {}),
    fingerprint: finding.fingerprint,
  });
  return result.success ? result.data : undefined;
}
