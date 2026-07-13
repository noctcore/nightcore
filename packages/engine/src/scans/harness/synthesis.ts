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
 * ORCHESTRATION. The prompt/persona builders live in `synthesis-prompt.ts`, artifact
 * grounding in `synthesis-artifacts.ts`, and proposal/drift grounding in
 * `synthesis-parse.ts` — all re-exported below so their pre-split import path
 * (`./synthesis.js`) still resolves. Like a {@link ScanManager} pass, it accepts an
 * injectable `runnerFactory` so tests can drive it with a fake runner (no SDK, no
 * subprocess), and an optional `runners` set + `isCancelled` probe so the orchestrator
 * can interrupt it mid-flight.
 */
import type {
  Config,
  ConventionFinding,
  HarnessProposal,
  ProposedArtifact,
  RepoProfile,
  SurfaceCommand,
  TokenUsage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type {
  ScanRunnerFactory,
  ScanSessionRunner,
} from '../shared/scan-manager.js';
import { runTailSession } from '../shared/tail-session.js';
import {
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS,
} from './presets.js';
import {
  conventionFingerprintSet,
  type ParsedSynthesis,
  parseSynthesis,
} from './synthesis-parse.js';
import { buildSynthesisPrompt, SYNTHESIS_PERSONA } from './synthesis-prompt.js';

// Preserve the module's pre-split public surface — siblings (`prompt.ts`) and tests
// import these from './synthesis.js'.
export { parseProposedArtifacts } from './synthesis-artifacts.js';
export { summarizeProfile } from './synthesis-prompt.js';
export { conventionFingerprintSet, parseSynthesis };
export type { ParsedSynthesis };

type StartHarnessScan = Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

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
