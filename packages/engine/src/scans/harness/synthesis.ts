/**
 * The Harness synthesis pass — ONE read-only Claude session that turns the repo
 * profile + the deduped convention findings into a set of {@link ProposedArtifact}s
 * (generated ESLint rules, lint-meta rules, an agent contract). It runs under the
 * SAME read-only tool restrictions + analyzer persona as a convention pass — it
 * inspects the repo to write ACCURATE rules but NEVER writes to disk; it returns the
 * proposed file CONTENT as JSON, and the Rust core owns the actual write.
 *
 * Like a {@link ScanManager} pass, it accepts an injectable `runnerFactory` so tests can
 * drive it with a fake runner (no SDK, no subprocess), and an optional `runners`
 * set + `isCancelled` probe so the orchestrator can interrupt it mid-flight.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
  Config,
  NightcoreEvent,
  ProposedArtifact,
  RepoProfile,
  SurfaceCommand,
  TokenUsage,
} from '@nightcore/contracts';
import {
  ArtifactKindSchema,
  ArtifactWriteModeSchema,
  ProposedArtifactSchema,
  type ConventionFinding,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';
import { extractJson } from '../shared/findings.js';
import { getNumber, getString, getStringArray } from '../../util/field-extract.js';
import {
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS,
  ANALYZER_PERSONA,
} from './presets.js';
import { HARNESS_REFERENCE } from './reference.js';
import {
  makeHeartbeat,
  type ScanRunnerFactory,
  type ScanSessionRunner,
} from '../shared/scan-manager.js';

type StartHarnessScan = Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

/** Per-pass turn ceiling for the synthesis session (it explores then writes). */
const DEFAULT_MAX_TURNS = 40;
/** Cap on proposed artifacts so a runaway pass can't flood the UI. */
const MAX_ARTIFACTS = 24;

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

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
  usage: TokenUsage;
  costUsd: number;
  error?: string;
}

/** The stable failure reason carried by a `session-failed` event. */
type SessionFailedReason = Extract<
  NightcoreEvent,
  { type: 'session-failed' }
>['reason'];

/**
 * Run the single synthesis session and return the grounded proposed artifacts. A
 * synthesis crash/parse-failure degrades to `{ artifacts: [], error }` — a scan
 * with findings but no proposals is still useful, so this never throws.
 */
export async function synthesizeHarness(
  args: SynthesizeHarnessArgs,
): Promise<SynthesizeHarnessResult> {
  if (args.isCancelled?.()) {
    return { artifacts: [], usage: { ...EMPTY_USAGE }, costUsd: 0, error: 'cancelled' };
  }

  const usage: TokenUsage = { ...EMPTY_USAGE };
  let costUsd = 0;
  let result: string | undefined;
  let error: string | undefined;
  let reason: SessionFailedReason | undefined;
  // Throttled progress so the (serial) synthesis tail shows life in the terminal
  // instead of running silent — its events never reach the wire.
  const heartbeat = makeHeartbeat(args.logger, '[harness:synthesis]');

  const prompt = buildSynthesisPrompt(
    args.profile,
    args.findings,
    args.inventory,
    args.command,
  );
  const runner = args.runnerFactory(
    {
      sessionId: -1,
      prompt,
      model: args.command.model ?? args.config.model,
      ...(args.command.effort ?? args.config.effort
        ? { effort: args.command.effort ?? args.config.effort }
        : {}),
      permissionMode: 'dontAsk',
      permissionPolicy: args.config.permissions,
      cwd: args.command.projectPath,
      apiKeyFallback: args.apiKeyFallback,
      settingSources: args.config.settingSources,
      todoFeatureEnabled: false,
      appendSystemPrompt: SYNTHESIS_PERSONA,
      allowedTools: [...ANALYSIS_ALLOWED_TOOLS],
      disallowedTools: [...ANALYSIS_DISALLOWED_TOOLS],
      maxTurns: args.command.maxTurnsPerCategory ?? DEFAULT_MAX_TURNS,
      ...(args.command.maxBudgetUsdPerCategory !== undefined
        ? { maxBudgetUsd: args.command.maxBudgetUsdPerCategory }
        : {}),
    },
    (event) => {
      if (event.type === 'session-completed') {
        result = event.result;
        costUsd = event.costUsd;
        if (event.usage !== undefined) addUsage(usage, event.usage);
      } else if (event.type === 'session-failed') {
        error = event.message;
        reason = event.reason;
      } else {
        heartbeat(event);
      }
    },
    args.logger?.child('harness-synthesis'),
  );

  args.runners?.add(runner);
  try {
    await runner.run();
  } finally {
    args.runners?.delete(runner);
  }

  if (args.isCancelled?.()) {
    return { artifacts: [], usage, costUsd, error: 'cancelled' };
  }
  if (result === undefined) {
    return {
      artifacts: [],
      usage,
      costUsd,
      error: error ?? (reason !== undefined ? `synthesis ${reason}` : 'no result'),
    };
  }

  const parsed = parseProposedArtifacts(result, args.command.projectPath);
  return {
    artifacts: parsed.artifacts,
    usage,
    costUsd,
    ...(parsed.error !== undefined ? { error: parsed.error } : {}),
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
    '  "kind": "lint-meta-rule|eslint-rule|eslint-plugin-file|eslint-config|agent-contract|custom-lint-plugin",',
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
    'Every `targetPath` MUST be repo-relative (no leading `/`, no `..`). Return [] if',
    `there is nothing worth proposing. Propose at most ${MAX_ARTIFACTS} artifacts.`,
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

/** The model's raw output is an array of artifacts, or an object with an
 *  `artifacts` array. Normalize to an array. */
function toRawArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') {
    const artifacts = (parsed as Record<string, unknown>).artifacts;
    if (Array.isArray(artifacts)) return artifacts;
  }
  return [];
}

/**
 * Parse + GROUND the synthesis result into validated artifacts. Tolerant:
 * malformed items are skipped. GROUNDING drops any artifact whose `targetPath` is
 * absolute, contains `..`, or escapes the repo root, and any with empty content —
 * the engine never proposes writing outside the repo or an empty file. Returns an
 * `error` only when NO JSON could be extracted at all.
 */
export function parseProposedArtifacts(
  raw: string,
  projectPath: string,
): { artifacts: ProposedArtifact[]; error?: string } {
  const parsed = extractJson(raw);
  if (parsed === undefined) {
    return { artifacts: [], error: 'no JSON artifacts array in synthesis output' };
  }
  const items = toRawArray(parsed);
  const artifacts: ProposedArtifact[] = [];
  for (const item of items) {
    const artifact = coerceArtifact(item, projectPath);
    if (artifact !== undefined) artifacts.push(artifact);
  }
  return { artifacts };
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

/** Accumulate token usage in place. */
function addUsage(into: TokenUsage, add: TokenUsage | undefined): void {
  if (add === undefined) return;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheCreationTokens += add.cacheCreationTokens;
}
