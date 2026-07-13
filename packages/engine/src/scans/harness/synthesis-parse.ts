/**
 * Top-level parse + ground for a synthesis answer: turn the model's JSON into validated
 * artifacts (via {@link coerceArtifact} in `synthesis-artifacts.ts`) AND the task-shaped
 * {@link HarnessProposal}s the user converts into board tasks. Proposals are grounded
 * against the surviving artifacts (no dangling/injected ids) and, for Drift-v1 (T15)
 * compiled checks, against the run's real convention fingerprints. Re-exported from
 * `synthesis.ts` for back-compat.
 */
import { createHash } from 'node:crypto';

import type {
  ConventionFinding,
  HarnessProposal,
  ProposedArtifact,
} from '@nightcore/contracts';
import {
  HarnessProposalKindSchema,
  HarnessProposalSchema,
} from '@nightcore/contracts';

import { getNumber, getString, getStringArray } from '../../util/field-extract.js';
import { extractJson, toRawArray } from '../../util/json-extract.js';
import { coerceArtifact } from './synthesis-artifacts.js';

/** Cap on task-shaped proposals so a runaway pass can't flood the board convert UI. */
export const MAX_PROPOSALS = 24;

/** The combined result of parsing a synthesis answer: the file-level artifacts AND the
 *  task-shaped proposals. `error` is set only when NO JSON could be extracted at all. */
export interface ParsedSynthesis {
  artifacts: ProposedArtifact[];
  proposals: HarnessProposal[];
  error?: string;
}

/**
 * Parse + GROUND a synthesis answer into artifacts AND proposals. Tolerant of both the
 * object envelope `{ artifacts, proposals }` and a bare artifacts array (→ no proposals),
 * so an older-style answer still yields artifacts. Proposals are grounded against the
 * PARSED artifacts: an `apply-artifacts` proposal keeps only `artifactIds` that survived
 * artifact grounding and is dropped if none remain (never references a rejected/injected
 * artifact); an `agent-task` proposal requires a non-empty `prompt`. Returns `error` only
 * when no JSON is present at all (drives the single corrective retry).
 *
 * `conventionFingerprints` is the set of REAL convention fingerprints the scan surfaced;
 * a compiled check's `conventionFingerprint` is grounded against it (a fingerprint that
 * matches no convention is dropped). Defaults to empty — an isolated caller that passes
 * no set simply gets no drift-linked checks (never a fabricated join).
 */
export function parseSynthesis(
  raw: string,
  projectPath: string,
  conventionFingerprints: ReadonlySet<string> = new Set(),
): ParsedSynthesis {
  const parsed = extractJson(raw);
  if (parsed === undefined) {
    return { artifacts: [], proposals: [], error: 'no JSON in synthesis output' };
  }
  const artifacts: ProposedArtifact[] = [];
  for (const item of toRawArray(parsed, 'artifacts')) {
    const artifact = coerceArtifact(item, projectPath);
    if (artifact !== undefined) artifacts.push(artifact);
  }
  const knownArtifactIds = new Set(artifacts.map((a) => a.id));
  const proposals: HarnessProposal[] = [];
  for (const item of toProposalArray(parsed)) {
    if (proposals.length >= MAX_PROPOSALS) break;
    const proposal = coerceProposal(item, knownArtifactIds, conventionFingerprints);
    if (proposal !== undefined) proposals.push(proposal);
  }
  return { artifacts, proposals };
}

/** The `conventionFingerprint`s of this run's CONVENTION-kind findings — the set a
 *  compiled drift check's fingerprint is grounded against. Drift measures conformance
 *  of conventions the codebase already follows, so `gap` findings (missing practices)
 *  are excluded: you cannot measure drift against a rule that isn't followed yet. */
export function conventionFingerprintSet(
  findings: ConventionFinding[],
): ReadonlySet<string> {
  return new Set(
    findings.filter((f) => f.kind === 'convention').map((f) => f.fingerprint),
  );
}

/** Pull the `proposals` array out of the object envelope; `[]` for a bare array or any
 *  shape without one. */
function toProposalArray(parsed: unknown): unknown[] {
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const proposals = (parsed as Record<string, unknown>).proposals;
    if (Array.isArray(proposals)) return proposals;
  }
  return [];
}

/** Stable fingerprint for a proposal: `kind | targetSignature` — the sorted artifact ids
 *  for an `apply-artifacts` bundle, or the verify command / prompt / title for an
 *  `agent-task` (whatever most stably identifies the SAME recommendation across re-scans). */
function proposalFingerprint(
  kind: HarnessProposal['kind'],
  artifactIds: string[],
  agentBasis: string,
): string {
  const target =
    kind === 'apply-artifacts' ? [...artifactIds].sort().join(',') : agentBasis.trim();
  return createHash('sha1').update(`${kind}|${target}`).digest('hex').slice(0, 16);
}

/** Coerce + ground one raw model item into a {@link HarnessProposal}, or drop it.
 *  `conventionFingerprints` is the set of REAL convention fingerprints this run
 *  surfaced — used to ground a compiled check's `conventionFingerprint` (T15). */
function coerceProposal(
  raw: unknown,
  knownArtifactIds: Set<string>,
  conventionFingerprints: ReadonlySet<string>,
): HarnessProposal | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  const kindResult = HarnessProposalKindSchema.safeParse(r.kind);
  if (!kindResult.success) return undefined;
  const kind = kindResult.data;

  const title = getString(r, 'title');
  const description = getString(r, 'description');
  if (title === undefined || description === undefined) return undefined;

  const rationale = getString(r, 'rationale');
  const confidence = getNumber(r, 'confidence');
  // Keep only artifact ids that survived artifact grounding — a proposal can never
  // reference a rejected/injected artifact.
  const artifactIds = getStringArray(r, 'artifactIds').filter((id) =>
    knownArtifactIds.has(id),
  );
  const prompt = getString(r, 'prompt');
  const verifyCommand = getString(r, 'verifyCommand');

  if (kind === 'apply-artifacts' && artifactIds.length === 0) return undefined;
  if (kind === 'agent-task' && (prompt === undefined || prompt.trim().length === 0)) {
    return undefined;
  }

  const harnessCheck = coerceHarnessCheck(r.harnessCheck, conventionFingerprints);
  const fingerprint = proposalFingerprint(
    kind,
    artifactIds,
    verifyCommand ?? prompt ?? title,
  );

  const candidate: Record<string, unknown> = {
    id: `${kind}-${fingerprint}`,
    kind,
    title,
    description,
    ...(rationale !== undefined ? { rationale } : {}),
    artifactIds,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(verifyCommand !== undefined ? { verifyCommand } : {}),
    ...(harnessCheck !== undefined ? { harnessCheck } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    fingerprint,
  };

  const result = HarnessProposalSchema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

/** Coerce a suggested gauntlet check `{ name, kind, command }` — all three must be
 *  non-empty strings, else the check is dropped (a partial suggestion is discarded, not
 *  patched). This is only a SUGGESTION; arming stays human-gated in Rust.
 *
 *  Drift-v1 (T15): a COMPILED check may additionally cite the `conventionFingerprint`
 *  of the convention it verifies. That fingerprint is GROUNDED against the run's real
 *  convention findings — a value matching no convention is DROPPED (the check survives
 *  as a plain suggestion), so a prompt-injected fingerprint can never fabricate a
 *  drift join. The check is never auto-armed regardless. */
function coerceHarnessCheck(
  raw: unknown,
  conventionFingerprints: ReadonlySet<string>,
): HarnessProposal['harnessCheck'] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const name = getString(r, 'name');
  const kind = getString(r, 'kind');
  const command = getString(r, 'command');
  if (
    name === undefined ||
    kind === undefined ||
    command === undefined ||
    name.trim().length === 0 ||
    command.trim().length === 0
  ) {
    return undefined;
  }
  const cited = getString(r, 'conventionFingerprint');
  const conventionFingerprint =
    cited !== undefined && conventionFingerprints.has(cited) ? cited : undefined;
  return {
    name,
    kind,
    command,
    ...(conventionFingerprint !== undefined ? { conventionFingerprint } : {}),
  };
}
