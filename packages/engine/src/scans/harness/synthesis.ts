/**
 * The Harness synthesis pass — ONE read-only Claude session that turns the repo
 * profile + the deduped convention findings into a set of {@link ProposedArtifact}s
 * (generated ESLint rules, lint-meta rules, an agent contract). It runs under the
 * SAME read-only tool restrictions + analyzer persona as a convention pass — it
 * inspects the repo to write ACCURATE rules but NEVER writes to disk; it returns the
 * proposed file CONTENT as JSON, and the Rust core owns the actual write.
 *
 * The session scaffold (runner spin + heartbeat + cancel probe + one corrective
 * retry) is the shared {@link runTailSession}; this module keeps only the synthesis
 * prompt builders and parse/ground helpers. Like a {@link ScanManager} pass, it
 * accepts an injectable `runnerFactory` so tests can drive it with a fake runner (no
 * SDK, no subprocess), and an optional `runners` set + `isCancelled` probe so the
 * orchestrator can interrupt it mid-flight.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type {
  Config,
  HarnessProposal,
  ProposedArtifact,
  RepoProfile,
  SurfaceCommand,
  TokenUsage,
} from '@nightcore/contracts';
import {
  ArtifactKindSchema,
  ArtifactWriteModeSchema,
  type ConventionFinding,
  HarnessProposalKindSchema,
  HarnessProposalSchema,
  ProposedArtifactSchema,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { getNumber, getString, getStringArray } from '../../util/field-extract.js';
import { extractJson, parseItems, toRawArray } from '../../util/json-extract.js';
import type {
  ScanRunnerFactory,
  ScanSessionRunner,
} from '../shared/scan-manager.js';
import { runTailSession } from '../shared/tail-session.js';
import {
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS,
  ANALYZER_PERSONA,
} from './presets.js';
import { hardeningReference,HARNESS_REFERENCE } from './reference.js';

type StartHarnessScan = Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

/** Cap on proposed artifacts so a runaway pass can't flood the UI. */
const MAX_ARTIFACTS = 24;
/** Cap on task-shaped proposals so a runaway pass can't flood the board convert UI. */
const MAX_PROPOSALS = 24;

export interface SynthesizeHarnessArgs {
  profile: RepoProfile;
  /** The deduped convention findings the artifacts should enforce. */
  findings: ConventionFinding[];
  /** The deterministic top-level repo map, already built once by the harness
   *  manager for the lens prompts — threaded through so synthesis reuses it
   *  instead of re-walking the filesystem. */
  inventory: string;
  command: StartHarnessScan;
  config: Config;
  apiKeyFallback: boolean;
  logger?: Logger;
  /** Constructs the synthesis runner (the orchestrator passes its resolved factory;
   *  tests inject a fake). */
  runnerFactory: ScanRunnerFactory;
  /** Live-runner registry the orchestrator shares so `cancel()` can interrupt the
   *  synthesis session too. Absent in isolated tests. */
  runners?: Set<ScanSessionRunner>;
  /** Returns true once the run was cancelled (skip work / mark aborted). */
  isCancelled?: () => boolean;
}

export interface SynthesizeHarnessResult {
  artifacts: ProposedArtifact[];
  /** The task-shaped proposals the user converts into board tasks. */
  proposals: HarnessProposal[];
  usage: TokenUsage;
  costUsd: number;
  error?: string;
}

/** The strict-JSON reminder appended to the ONE corrective synthesis retry — the
 *  synthesis analog of the per-lens `retryReminderSuffix`. */
const SYNTHESIS_RETRY_REMINDER =
  '\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON object { "artifacts": [...], "proposals": [...] }, nothing else.';

/**
 * Run the synthesis session and return the grounded proposed artifacts. Mirrors the
 * per-lens corrective retry the base {@link ScanManager} does: on an unparseable first
 * result it re-asks ONCE with a strict-JSON reminder rather than silently degrading to
 * zero proposals — synthesis is the single most expensive output in the scan (paid for
 * by every lens pass), so losing it to a formatting slip is not acceptable. A session
 * failure (no result) or a second unparseable result still degrades to
 * `{ artifacts: [], error }` — a scan with findings is useful.
 */
export async function synthesizeHarness(
  args: SynthesizeHarnessArgs,
): Promise<SynthesizeHarnessResult> {
  // The real convention fingerprints a compiled drift check may cite — grounded once
  // per run so an injected/hallucinated fingerprint can never fabricate a drift join.
  const conventionFingerprints = conventionFingerprintSet(args.findings);
  const tail = await runTailSession<ParsedSynthesis>({
    prompt: buildSynthesisPrompt(
      args.profile,
      args.findings,
      args.inventory,
      args.command,
    ),
    persona: SYNTHESIS_PERSONA,
    tools: {
      allowed: ANALYSIS_ALLOWED_TOOLS,
      disallowed: ANALYSIS_DISALLOWED_TOOLS,
    },
    command: args.command,
    config: args.config,
    apiKeyFallback: args.apiKeyFallback,
    ...(args.logger !== undefined ? { logger: args.logger } : {}),
    runnerFactory: args.runnerFactory,
    ...(args.runners !== undefined ? { runners: args.runners } : {}),
    ...(args.isCancelled !== undefined ? { isCancelled: args.isCancelled } : {}),
    label: 'harness:synthesis',
    retryReminder: SYNTHESIS_RETRY_REMINDER,
    // parseSynthesis always yields a (possibly empty) value; its `error` — set only
    // when NO JSON could be extracted — drives the corrective retry.
    parse: (raw) => {
      const parsed = parseSynthesis(
        raw,
        args.command.projectPath,
        conventionFingerprints,
      );
      return {
        value: parsed,
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

  // UNLIKE the PR-review tails, synthesis does NOT fail open on a crash: a thrown
  // runner propagates to the ScanManager catch (→ `harness-scan-failed`, reason
  // `runner-crash`), preserving the scan-level crash contract.
  if (tail.crashed === true) {
    throw tail.crashError instanceof Error
      ? tail.crashError
      : new Error(String(tail.crashError));
  }

  return {
    artifacts: tail.value?.artifacts ?? [],
    proposals: tail.value?.proposals ?? [],
    usage: tail.usage,
    costUsd: tail.costUsd,
    ...(tail.error !== undefined ? { error: tail.error } : {}),
  };
}

/** The synthesis persona — the read-only analyzer, now asked to PROPOSE (never
 *  write) an enforceable harness as JSON content. The string literally says
 *  "SYNTHESIZING" so a test fake can route this session distinctly. */
const SYNTHESIS_PERSONA = [
  ANALYZER_PERSONA,
  'You are now SYNTHESIZING an enforceable harness from the conventions found.',
  'You STILL never write or edit files — you return the proposed file CONTENT as',
  'JSON; the host applies it. Inspect the repo to make the rules accurate.',
].join(' ');

/** Compose the synthesis user prompt: reference + profile summary + findings +
 *  the artifact output contract. The `inventory` (deterministic top-level repo map)
 *  is built once by the harness manager and threaded in to avoid a second fs walk. */
function buildSynthesisPrompt(
  profile: RepoProfile,
  findings: ConventionFinding[],
  inventory: string,
  command: StartHarnessScan,
): string {
  return [
    `You are designing an enforceable harness for the project at: ${command.projectPath}`,
    '',
    HARNESS_REFERENCE,
    '',
    hardeningReference(profile),
    '',
    'REPO PROFILE (deterministically detected):',
    summarizeProfile(profile),
    '',
    'REPO MAP (deterministic top-level inventory — start from this, do not re-list the tree):',
    inventory,
    '',
    'CONVENTION FINDINGS to enforce (reference these by fingerprint in sourceFindings):',
    summarizeFindings(findings),
    '',
    artifactOutputContract(profile),
  ].join('\n');
}

/** A compact, model-readable summary of the repo profile. Exported so the lens
 *  passes (harness-manager) ground each prompt on the SAME profile summary. */
export function summarizeProfile(profile: RepoProfile): string {
  const lines = [
    `- monorepo: ${profile.isMonorepo} (workspace tool: ${profile.workspaceTool})`,
    `- packages: ${
      profile.packages.length > 0
        ? profile.packages.map((p) => `${p.name} [${p.role}] (${p.path})`).join(', ')
        : 'none'
    }`,
    `- languages: ${profile.languages.join(', ') || 'unknown'}`,
    `- frameworks: ${profile.frameworks.join(', ') || 'none detected'}`,
    `- eslint flat config: ${profile.hasEslintFlatConfig}`,
    `- lint-meta engine: ${profile.hasLintMeta}`,
    `- agent docs: ${profile.hasAgentDocs}`,
    `- existing eslint plugins: ${profile.existingPlugins.join(', ') || 'none'}`,
  ];
  return lines.join('\n');
}

/** A compact list of findings (fingerprint + kind + title + suggestion). */
function summarizeFindings(findings: ConventionFinding[]): string {
  if (findings.length === 0) return '- (no convention findings)';
  return findings
    .map((f) => {
      const tail = f.suggestion !== undefined ? ` → ${f.suggestion}` : '';
      return `- (${f.fingerprint}) [${f.category}/${f.kind}] ${f.title}${tail}`;
    })
    .join('\n');
}

/** The JSON contract for the proposed artifacts. */
function artifactOutputContract(profile: RepoProfile): string {
  const eslintAllowed = profile.isMonorepo || profile.hasEslintFlatConfig;
  return [
    'Propose the harness as a JSON array (no prose, no markdown fences) where each',
    'element is:',
    '{',
    '  "kind": "lint-meta-rule|eslint-rule|eslint-plugin-file|eslint-config|agent-contract|custom-lint-plugin|tool-config",',
    '  "group": "optional group id; share it across files that ship together",',
    '  "groupTitle": "optional human label for the group",',
    '  "title": "one-line headline",',
    '  "description": "what this artifact is / does",',
    '  "rationale": "why, tied to the conventions it enforces (optional)",',
    '  "targetPath": "repo/relative/destination/path",',
    '  "writeMode": "create|merge-section",',
    '  "content": "the FULL file content (create) or the managed-section body (merge-section)",',
    '  "language": "typescript|markdown|json (optional)",',
    '  "sourceFindings": ["fingerprints of the findings this enforces"],',
    '  "dependsOn": ["ids of artifacts this one needs (optional)"]',
    '}',
    eslintAllowed
      ? [
          'CUSTOM LINT PLUGIN — when the conventions are concrete enough to enforce',
          'with AST rules, generate a project-specific ESLint plugin as a multi-file',
          'BUNDLE: emit SEVERAL `eslint-plugin-file` artifacts that ALL share one',
          '`group:"eslint-plugin"` (and the same `groupTitle`), namely:',
          '  - a scaffold `index.js` that re-exports `{ rules }` (the plugin entry),',
          '  - ONE file per rule under `rules/<rule-name>.js` (a real AST rule:',
          '    `meta` + `create(context)` returning a selector→`context.report` visitor,',
          '    with an optional `fix` when the change is mechanical),',
          '  - a `tests/<rule-name>.test.js` fixture exercising the rule so the plugin',
          '    self-verifies (valid + invalid cases) — derive each rule + fixture from a',
          '    specific convention finding and cite it in `sourceFindings`.',
          'Make each rule file `dependsOn` the scaffold `index.js` id so the scaffold',
          'is written first. ADDITIONALLY emit ONE `custom-lint-plugin` artifact sharing',
          'the SAME `group` — a short `agent-contract`-style or `markdown` summary',
          '(e.g. `<plugin-dir>/README.md`) that LABELS the bundle as a generated lint',
          'plugin and lists its rules; this is the group header the UI surfaces.',
          'A simpler one-off ESLint rule that is NOT a full plugin stays a single',
          '`eslint-plugin-file` with no `custom-lint-plugin` companion.',
        ].join('\n')
      : 'This repo has no monorepo/eslint host: prefer an `agent-contract` plus minimal rules; do NOT scaffold a full plugin package or a `custom-lint-plugin` bundle.',
    'CLAUDE.md / AGENTS.md guardrail docs use `agent-contract` + `writeMode:"merge-section"`.',
    '`tool-config` is a standalone hardening config file (see HARDENING MODULES above),',
    'always `writeMode:"create"` at a path that does not exist yet.',
    'Every `targetPath` MUST be repo-relative (no leading `/`, no `..`).',
    `Propose at most ${MAX_ARTIFACTS} artifacts.`,
    '',
    proposalOutputContract(eslintAllowed),
  ].join('\n');
}

/** The JSON contract for the task-shaped proposals. Proposals ride ALONGSIDE the
 *  artifacts in an object envelope; a bare artifacts array is still accepted (→ no
 *  proposals) so an older-style answer never fails the parse. */
function proposalOutputContract(eslintAllowed: boolean): string {
  return [
    'Return your whole answer as a JSON OBJECT with two arrays (no prose, no fences):',
    '{ "artifacts": [ …the artifacts above… ], "proposals": [ …see below… ] }',
    '',
    'A PROPOSAL is a task-shaped recommendation the user turns into ONE board task. Each is:',
    '{',
    '  "kind": "apply-artifacts | agent-task",',
    '  "title": "one-line headline (becomes the task title)",',
    '  "description": "what to do, concretely (becomes the task body)",',
    '  "rationale": "why it matters / what an agent breaks without it (optional)",',
    '  "artifactIds": ["ids of the artifacts this bundles"]  // apply-artifacts ONLY,',
    '  "prompt": "the instruction for the agent to perform"   // agent-task ONLY,',
    '  "verifyCommand": "a command that MUST pass when done, e.g. npx eslint ."  // agent-task, optional,',
    '  "harnessCheck": { "name": "…", "kind": "lint-meta | shell | lint-plugin", "command": "…", "conventionFingerprint": "…" }  // optional',
    '}',
    driftCompileContract(),
    'Use `apply-artifacts` for changes that are safe to write straight to disk (new docs,',
    'a new lint config file, a generated plugin BUNDLE): set `artifactIds` to the ids of',
    'the artifacts that ship together (group members share one proposal).',
    eslintAllowed
      ? 'Use `agent-task` for changes that must NOT be a blind write — WIRING the generated plugin into `eslint.config.*`, editing `package.json` scripts, adding a pre-commit hook: describe the change in `prompt`, and set `verifyCommand` to the command that proves it works (e.g. the lint command). These become worktree Build tasks a human reviews as a diff — never a direct file write.'
      : 'This repo has no eslint host: prefer `apply-artifacts` proposals for the docs/rules; use `agent-task` only for a genuinely execution-adjacent change.',
    `Return "proposals": [] if there is nothing worth proposing. At most ${MAX_PROPOSALS} proposals.`,
  ].join('\n');
}

/** The Drift-v1 (T15) compiled-check contract: for a convention the codebase ALREADY
 *  follows and that can be verified DETERMINISTICALLY, compile a check so a later run
 *  can measure whether the convention still holds at every site. Deliberately narrow:
 *  the v0.3 substrate is lint-meta rules + shell/ripgrep counts ONLY, and a check is
 *  only ever a SUGGESTION a human reviews and arms — synthesis never arms anything. */
function driftCompileContract(): string {
  return [
    '',
    'COMPILE DRIFT CHECKS (only for conventions the repo ALREADY follows):',
    'For each CONVENTION finding above (kind = convention, not a gap) that you are',
    'CONFIDENT can be verified by a DETERMINISTIC, mechanical check, compile ONE check',
    'and attach it to the proposal as its `harnessCheck`. Set `conventionFingerprint` to',
    "that convention's EXACT fingerprint — the `(<fingerprint>)` prefix in the findings",
    'list above. Two substrates ONLY (v0.3):',
    '  - STRUCTURAL / PATH / NAMING / FOLDER conventions → a lint-meta rule. Emit a',
    '    `lint-meta-rule` artifact holding the rule body, reference it from an',
    '    `apply-artifacts` proposal, and give that proposal a `harnessCheck` with',
    '    `kind:"lint-meta"` and a `command` that runs the rule.',
    '  - TEXTUAL / CONTENT conventions (a required/forbidden token, import form, header)',
    '    → a shell check. Use an `agent-task` proposal whose `harnessCheck` has',
    '    `kind:"shell"` and a `command` that COUNTS violating sites with ripgrep, e.g.',
    "    `rg --count-matches 'pattern' src` or `rg -c 'pattern' src` (a count is what an",
    '    EnforceRun turns into site totals).',
    'ONLY compile a check you can express as a deterministic rule/command. If a convention',
    'needs human judgement or a semantic read to verify, SKIP it — do NOT invent a check;',
    'it simply stays unmeasured (honest). Do NOT use ESLint rules or ast-grep for drift',
    'checks in v0.3. Every compiled check is a SUGGESTION reviewed and armed by a human —',
    'never assume it runs, and never propose auto-arming it.',
  ].join('\n');
}

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

/** Coerce + ground one raw model item into a {@link ProposedArtifact}. */
function coerceArtifact(
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
