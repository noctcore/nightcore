/**
 * Artifact grounding for the Harness synthesis pass: coerce one raw model item into a
 * validated {@link ProposedArtifact}, dropping anything that would write outside the repo,
 * write an empty file, or reach an auto-run execution sink. The execution-sink denylist
 * here mirrors the authoritative Rust apply boundary (`harness/apply.rs`) so the UI never
 * previews an artifact the core would reject. Consumed by {@link parseSynthesis} (in
 * `synthesis-parse.ts`) and re-exported from `synthesis.ts` for back-compat.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { ProposedArtifact } from '@nightcore/contracts';
import {
  ArtifactKindSchema,
  ArtifactWriteModeSchema,
  ProposedArtifactSchema,
} from '@nightcore/contracts';

import { getNumber, getString, getStringArray } from '../../util/field-extract.js';
import { parseItems } from '../../util/json-extract.js';

/** Cap on proposed artifacts so a runaway pass can't flood the UI. */
export const MAX_ARTIFACTS = 24;

/** Normalize a repo-relative path (strip leading `./`, backslashes → `/`). */
function normalizeTargetPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/** Stable fingerprint for an artifact: `kind | normalizedTargetPath`. */
function artifactFingerprint(kind: string, targetPath: string): string {
  const basis = `${kind}|${normalizeTargetPath(targetPath)}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/**
 * Parse + GROUND the synthesis result into validated artifacts. Tolerant:
 * malformed items are skipped. GROUNDING drops any artifact whose `targetPath` is
 * absolute, contains `..`, or escapes the repo root, and any with empty content —
 * the engine never proposes writing outside the repo or an empty file. Returns an
 * `error` when NO JSON could be extracted at all, or when the extracted JSON is
 * neither an array nor an object exposing an `artifacts` array (the shared parse
 * contract).
 */
export function parseProposedArtifacts(
  raw: string,
  projectPath: string,
): { artifacts: ProposedArtifact[]; error?: string } {
  const { items, error } = parseItems(
    raw,
    'artifacts',
    (item) => coerceArtifact(item, projectPath),
    'no JSON artifacts array in synthesis output',
  );
  return { artifacts: items, ...(error !== undefined ? { error } : {}) };
}

/** Coerce + ground one raw model item into a {@link ProposedArtifact}. */
export function coerceArtifact(
  raw: unknown,
  projectPath: string,
): ProposedArtifact | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  const kindResult = ArtifactKindSchema.safeParse(r.kind);
  if (!kindResult.success) return undefined;
  const kind = kindResult.data;

  const title = getString(r, 'title');
  const description = getString(r, 'description');
  const rawTarget = getString(r, 'targetPath');
  const content = getString(r, 'content');
  if (
    title === undefined ||
    description === undefined ||
    rawTarget === undefined ||
    content === undefined ||
    content.trim().length === 0
  ) {
    return undefined;
  }

  const targetPath = normalizeTargetPath(rawTarget);
  if (!isContainedPath(projectPath, targetPath)) return undefined;
  // Drop auto-run execution-sink targets (`.claude`/`.vscode` config, package.json
  // lifecycle, make, direnv, git-hook/CI dirs) so an injected proposal never reaches the
  // one-click preview. The authoritative gate is the Rust apply path (harness/apply.rs);
  // this mirror is defense-in-depth + UX — we never show an artifact that would be rejected.
  if (targetsExecutionSink(targetPath)) return undefined;

  const fingerprint = artifactFingerprint(kind, targetPath);
  const writeMode = ArtifactWriteModeSchema.safeParse(r.writeMode).success
    ? (r.writeMode as ProposedArtifact['writeMode'])
    : 'create';
  // merge-section rewrites a pre-existing file, so it is confined to the agent docs it
  // manages (matches the Rust `write_merge_section` allowlist).
  if (writeMode === 'merge-section' && !isAgentDocBasename(targetPath)) return undefined;

  const group = getString(r, 'group');
  const groupTitle = getString(r, 'groupTitle');
  const rationale = getString(r, 'rationale');
  const language = getString(r, 'language');
  const confidence = getNumber(r, 'confidence');

  const candidate: Record<string, unknown> = {
    id: `${kind}-${fingerprint}`,
    kind,
    ...(group !== undefined ? { group } : {}),
    ...(groupTitle !== undefined ? { groupTitle } : {}),
    title,
    description,
    ...(rationale !== undefined ? { rationale } : {}),
    targetPath,
    writeMode,
    content,
    ...(language !== undefined ? { language } : {}),
    sourceFindings: getStringArray(r, 'sourceFindings'),
    dependsOn: getStringArray(r, 'dependsOn'),
    ...(confidence !== undefined ? { confidence } : {}),
    fingerprint,
  };

  const result = ProposedArtifactSchema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

/** Auto-run execution-sink directory prefixes + file basenames the Rust apply boundary
 *  rejects. Kept in lockstep with `DENIED_TARGET_PREFIXES` / `DENIED_TARGET_BASENAMES` in
 *  `apps/desktop/src-tauri/src/sidecar/harness/apply.rs` — the Rust core is authoritative;
 *  this list only spares the user a preview of an artifact that would be rejected on apply. */
const EXECUTION_SINK_PREFIXES = [
  '.git/',
  '.github/workflows/',
  '.husky/',
  '.circleci/',
  '.claude/',
  '.vscode/',
];
const EXECUTION_SINK_BASENAMES = new Set([
  'package.json',
  'makefile',
  'gnumakefile',
  '.envrc',
  '.pre-commit-config.yaml',
  '.gitlab-ci.yml',
  '.gitlab-ci.yaml',
  // lefthook config: its recipe bodies run as git hooks once `lefthook install` has
  // wired the repo (and dropping the file re-arms an already-wired one), so
  // commit-discipline output (#18) must be an agent-task, never an artifact. Every
  // config name lefthook resolves.
  'lefthook.yml',
  '.lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yaml',
  'lefthook.toml',
  '.lefthook.toml',
  'lefthook.json',
  '.lefthook.json',
  // devcontainer config: postCreateCommand/onCreateCommand execute on container
  // create/attach, so the sandbox module (#15) routes devcontainers through a
  // human-reviewed agent task — never a one-click artifact. Covers the canonical
  // `.devcontainer/devcontainer.json` (basename matches at any depth) and the root
  // `.devcontainer.json` dot-form.
  'devcontainer.json',
  '.devcontainer.json',
]);
/** Basenames a `merge-section` write may target (agent-contract docs only). */
const MERGE_SECTION_ALLOWED_BASENAMES = new Set([
  'claude.md',
  'agents.md',
  'agent_contract.md',
]);

/** Whether a normalized repo-relative path targets an auto-run execution sink. */
function targetsExecutionSink(rel: string): boolean {
  const lower = rel.toLowerCase();
  if (EXECUTION_SINK_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return EXECUTION_SINK_BASENAMES.has(lower.split('/').pop() ?? '');
}

/** Whether a normalized path's basename is an agent-contract doc. */
function isAgentDocBasename(rel: string): boolean {
  return MERGE_SECTION_ALLOWED_BASENAMES.has((rel.split('/').pop() ?? '').toLowerCase());
}

/** Whether a repo-relative path stays inside the project root (no absolute, no
 *  `..` escape). The file need NOT exist (it is a proposed NEW file). */
function isContainedPath(projectPath: string, rel: string): boolean {
  if (rel.length === 0) return false;
  if (path.isAbsolute(rel)) return false;
  if (rel.split(/[\\/]/).includes('..')) return false;
  const abs = path.resolve(projectPath, rel);
  const root = path.resolve(projectPath);
  return abs === root || abs.startsWith(root + path.sep);
}
