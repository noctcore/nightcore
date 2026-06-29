/**
 * The Harness scan orchestrator. Detects a deterministic repo profile, then fans
 * out one READ-ONLY Claude pass per convention lens (bounded-concurrent, mirroring
 * {@link AnalysisManager}), grounds each pass's findings, streams `harness-*`
 * events, dedups across lenses, runs ONE synthesis pass that proposes enforceable
 * artifacts, and emits a final `harness-scan-completed`. The lens + synthesis
 * sub-sessions are INTERNAL: their ordinary session events are consumed here and
 * never reach the main event stream — only `harness-*` events do.
 *
 * Two hops over Insight: a `harness-profile-ready` up front (the deterministic
 * profile, no session) and a `harness-proposals-ready` near the end (the
 * synthesized artifacts). Degrade-not-throw throughout: any crash surfaces as a
 * `harness-scan-failed` event, never a rejected promise.
 */
import type {
  Config,
  ConventionCategory,
  ConventionFinding,
  NightcoreEvent,
  ProposedArtifact,
  RepoProfile,
  SurfaceCommand,
  TokenUsage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';
import { SessionRunner } from '../../session/session-runner.js';
import type {
  AnalysisRunnerFactory,
  AnalysisSessionRunner,
} from '../shared/manager.js';
import {
  buildRepoInventory,
  fmtCost,
  fmtElapsed,
  fmtSecs,
  makeHeartbeat,
  runPool,
} from '../shared/manager.js';
import {
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS,
  ANALYZER_PERSONA,
  conventionOutputContract,
  harnessPreset,
  type HarnessPreset,
} from './presets.js';
import {
  dedupeConventionFindings,
  groundConventionFindings,
  parseConventionFindings,
} from './findings.js';
import { detectRepoProfile } from './repo-profile.js';
import { summarizeProfile, synthesizeHarness } from './synthesis.js';

/** The `start-harness-scan` command variant (the zod schema is exported as a value,
 *  so the engine narrows the union for the type). */
type StartHarnessScan = Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

/** The runner factory + slice the orchestrator drives — REUSED from the Insight
 *  orchestrator so the two share one fake-runner injection shape in tests. */
export type HarnessRunnerFactory = AnalysisRunnerFactory;
export type HarnessSessionRunner = AnalysisSessionRunner;

/** Default number of convention passes to run at once. A 6-wide pool finishes a
 *  multi-lens scan in fewer serial waves; still bounded so we never open all lenses'
 *  paid Claude subprocesses at once. `runPool` caps this at `categories.length`, and
 *  `command.maxConcurrency` overrides it. */
const DEFAULT_CONCURRENCY = 6;
/** Per-lens turn ceiling (the model explores then writes findings). */
const DEFAULT_MAX_TURNS = 40;
/** Findings cap per convention pass. */
const MAX_FINDINGS_PER_CATEGORY = 8;

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** The stable failure reason carried by a `session-failed` event. */
type SessionFailedReason = Extract<
  NightcoreEvent,
  { type: 'session-failed' }
>['reason'];

const defaultRunnerFactory: HarnessRunnerFactory = (config, emit, logger) =>
  new SessionRunner(config, emit, logger);

export interface HarnessManagerDeps {
  config: Config;
  apiKeyFallback: boolean;
  emit: (event: NightcoreEvent) => void;
  logger?: Logger;
  /** Override the per-pass runner construction (tests inject a fake). Defaults to
   *  the real `SessionRunner` so the production call site needs no change. */
  runnerFactory?: HarnessRunnerFactory;
}

interface ActiveRun {
  runId: string;
  runners: Set<HarnessSessionRunner>;
  cancelled: boolean;
}

interface CategoryOutcome {
  findings: ConventionFinding[];
  usage: TokenUsage;
  costUsd: number;
  error?: string;
  reason?: SessionFailedReason;
}

export class HarnessManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly runnerFactory: HarnessRunnerFactory;

  constructor(private readonly deps: HarnessManagerDeps) {
    this.runnerFactory = deps.runnerFactory ?? defaultRunnerFactory;
  }

  /** Start a scan. Fire-and-forget: failures surface as a `harness-scan-failed`
   *  event, never a rejected promise (degrade-not-throw, like the SessionManager). */
  start(command: StartHarnessScan): void {
    if (this.active.has(command.runId)) {
      this.deps.logger?.debug('harness run already active; ignoring start', {
        runId: command.runId,
      });
      return;
    }
    void this.runScan(command);
  }

  /** Cancel an in-flight scan: abort every live convention pass + the synthesis. */
  cancel(runId: string): void {
    const run = this.active.get(runId);
    if (run === undefined) return;
    run.cancelled = true;
    for (const runner of run.runners) {
      void runner.interrupt();
    }
  }

  private async runScan(command: StartHarnessScan): Promise<void> {
    const { emit } = this.deps;
    const run: ActiveRun = {
      runId: command.runId,
      runners: new Set(),
      cancelled: false,
    };
    this.active.set(command.runId, run);
    const startedAt = Date.now();

    const model = command.model ?? this.deps.config.model;
    emit({
      type: 'harness-scan-started',
      runId: command.runId,
      categories: command.categories,
      model,
    });
    this.deps.logger?.info(
      `[harness] scan started — ${command.categories.length} lenses · model ${model}`,
    );

    const all: ConventionFinding[] = [];
    const categoriesRun: ConventionCategory[] = [];
    let totalCost = 0;
    const totalUsage: TokenUsage = { ...EMPTY_USAGE };

    try {
      // Deterministic profile first — a cheap fs pass, no session.
      const profile = detectRepoProfile(command.projectPath);
      emit({ type: 'harness-profile-ready', runId: command.runId, profile });
      this.deps.logger?.info(
        `[harness] profile detected — ${profile.isMonorepo ? `monorepo (${profile.workspaceTool})` : 'single package'} · ${profile.packages.length} packages · ${profile.languages.join('/') || 'unknown'}`,
      );

      // Deterministic top-level map injected into every lens + the synthesis pass so
      // each starts from a known structure instead of re-discovering the tree.
      const inventory = buildRepoInventory(command.projectPath);

      await runPool(
        command.categories,
        command.maxConcurrency ?? DEFAULT_CONCURRENCY,
        async (category) => {
          if (run.cancelled) return;
          const categoryStartedAt = Date.now();
          emit({
            type: 'harness-category-started',
            runId: command.runId,
            category,
          });
          this.deps.logger?.info(`[harness] lens ${category}: started`);

          const outcome = await this.runCategory(
            command,
            category,
            run,
            profile,
            inventory,
          );
          if (run.cancelled) return;

          const grounded = groundConventionFindings(
            outcome.findings,
            command.projectPath,
          );
          categoriesRun.push(category);
          totalCost += outcome.costUsd;
          addUsage(totalUsage, outcome.usage);
          all.push(...grounded);

          emit({
            type: 'harness-category-completed',
            runId: command.runId,
            category,
            findings: grounded,
            usage: outcome.usage,
            costUsd: outcome.costUsd,
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          });
          this.deps.logger?.info(
            `[harness] lens ${category}: completed — ${grounded.length} findings, ${fmtCost(outcome.costUsd)}, ${fmtSecs(Date.now() - categoryStartedAt)}`,
          );
        },
      );

      if (run.cancelled) {
        emit({
          type: 'harness-scan-failed',
          runId: command.runId,
          reason: 'aborted',
          message: 'harness scan cancelled',
        });
        return;
      }

      const deduped = dedupeConventionFindings(all);

      // Synthesis: one read-only pass that proposes the harness artifacts. A
      // failure degrades to no proposals — a scan with findings is still useful.
      // Announce the start so the UI swaps the all-lenses-done dead zone for a
      // "Synthesizing harness…" state and the terminal marks the (serial) tail.
      emit({ type: 'harness-synthesis-started', runId: command.runId });
      this.deps.logger?.info(
        `[harness] synthesis: started — ${deduped.length} findings to enforce`,
      );
      const synthesisStartedAt = Date.now();
      let artifacts: ProposedArtifact[] = [];
      const synthesis = await synthesizeHarness({
        profile,
        findings: deduped,
        inventory,
        command,
        config: this.deps.config,
        apiKeyFallback: this.deps.apiKeyFallback,
        ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {}),
        runnerFactory: this.runnerFactory,
        runners: run.runners,
        isCancelled: () => run.cancelled,
      });
      totalCost += synthesis.costUsd;
      addUsage(totalUsage, synthesis.usage);
      this.deps.logger?.info(
        `[harness] synthesis: completed — ${synthesis.artifacts.length} artifacts, ${fmtCost(synthesis.costUsd)}, ${fmtSecs(Date.now() - synthesisStartedAt)}`,
      );
      if (synthesis.error !== undefined) {
        this.deps.logger?.warn('harness synthesis produced no proposals', {
          runId: command.runId,
          error: synthesis.error,
        });
      } else {
        artifacts = synthesis.artifacts;
      }

      if (run.cancelled) {
        emit({
          type: 'harness-scan-failed',
          runId: command.runId,
          reason: 'aborted',
          message: 'harness scan cancelled',
        });
        return;
      }

      emit({
        type: 'harness-proposals-ready',
        runId: command.runId,
        artifacts,
      });

      const durationMs = Date.now() - startedAt;
      emit({
        type: 'harness-scan-completed',
        runId: command.runId,
        profile,
        findings: deduped,
        artifacts,
        categoriesRun,
        costUsd: totalCost,
        durationMs,
        usage: totalUsage,
      });
      this.deps.logger?.info(
        `[harness] scan completed — ${deduped.length} findings, ${artifacts.length} proposals across ${categoriesRun.length} lenses, ${fmtCost(totalCost)}, ${fmtElapsed(durationMs)}`,
      );
    } catch (error) {
      this.deps.logger?.warn('harness scan crashed', error);
      emit({
        type: 'harness-scan-failed',
        runId: command.runId,
        reason: run.cancelled ? 'aborted' : 'runner-crash',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.active.delete(command.runId);
    }
  }

  /** Run one convention pass (with one corrective retry on unparseable output). */
  private async runCategory(
    command: StartHarnessScan,
    category: ConventionCategory,
    run: ActiveRun,
    profile: RepoProfile,
    inventory: string,
  ): Promise<CategoryOutcome> {
    const preset = harnessPreset(category);
    const usage: TokenUsage = { ...EMPTY_USAGE };
    let costUsd = 0;

    const first = await this.runOneSession(
      command,
      preset,
      buildCategoryPrompt(command, preset, profile, inventory),
      run,
    );
    addUsage(usage, first.usage);
    costUsd += first.costUsd;

    if (run.cancelled) {
      return { findings: [], usage, costUsd, error: 'cancelled', reason: 'aborted' };
    }
    if (first.result === undefined) {
      return {
        findings: [],
        usage,
        costUsd,
        error: first.error ?? 'no result',
        ...(first.reason !== undefined ? { reason: first.reason } : {}),
      };
    }

    let parsed = parseConventionFindings(first.result, category);
    let reason = first.reason;
    if (parsed.error !== undefined) {
      // One corrective retry: the pass returned prose, not JSON. Re-ask with a
      // strict reminder (cheap relative to losing the whole lens).
      this.deps.logger?.debug('harness lens produced no JSON; retrying', {
        runId: command.runId,
        category,
      });
      const retry = await this.runOneSession(
        command,
        preset,
        `${buildCategoryPrompt(command, preset, profile, inventory)}\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON array, nothing else.`,
        run,
      );
      addUsage(usage, retry.usage);
      costUsd += retry.costUsd;
      if (run.cancelled) reason = 'aborted';
      else if (retry.result !== undefined) {
        parsed = parseConventionFindings(retry.result, category);
        reason = retry.reason;
      } else if (retry.reason !== undefined) {
        reason = retry.reason;
      }
    }

    return {
      findings: parsed.findings,
      usage,
      costUsd,
      ...(parsed.error !== undefined ? { error: parsed.error } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  /** Spin one read-only SessionRunner and capture its terminal result/usage. The
   *  runner's events are consumed locally and never forwarded to the main stream. */
  private async runOneSession(
    command: StartHarnessScan,
    preset: HarnessPreset,
    prompt: string,
    run: ActiveRun,
  ): Promise<{
    result?: string;
    usage: TokenUsage;
    costUsd: number;
    error?: string;
    reason?: SessionFailedReason;
  }> {
    let result: string | undefined;
    let usage: TokenUsage = { ...EMPTY_USAGE };
    let costUsd = 0;
    let error: string | undefined;
    let reason: SessionFailedReason | undefined;
    // Throttled progress so a long lens shows life in the terminal instead of
    // running silent until it completes (its events never reach the wire).
    const heartbeat = makeHeartbeat(
      this.deps.logger,
      `[harness:${preset.category}]`,
    );

    const runner = this.runnerFactory(
      {
        sessionId: -1,
        prompt,
        model: command.model ?? this.deps.config.model,
        ...(command.effort ?? this.deps.config.effort
          ? { effort: command.effort ?? this.deps.config.effort }
          : {}),
        permissionMode: 'dontAsk',
        permissionPolicy: this.deps.config.permissions,
        cwd: command.projectPath,
        apiKeyFallback: this.deps.apiKeyFallback,
        settingSources: this.deps.config.settingSources,
        todoFeatureEnabled: false,
        appendSystemPrompt: `${ANALYZER_PERSONA} For this pass, look for: ${preset.focus}`,
        allowedTools: [...ANALYSIS_ALLOWED_TOOLS],
        disallowedTools: [...ANALYSIS_DISALLOWED_TOOLS],
        maxTurns: command.maxTurnsPerCategory ?? DEFAULT_MAX_TURNS,
        ...(command.maxBudgetUsdPerCategory !== undefined
          ? { maxBudgetUsd: command.maxBudgetUsdPerCategory }
          : {}),
      },
      (event) => {
        if (event.type === 'session-completed') {
          result = event.result;
          costUsd = event.costUsd;
          if (event.usage !== undefined) usage = event.usage;
        } else if (event.type === 'session-failed') {
          error = event.message;
          reason = event.reason;
        } else {
          heartbeat(event);
        }
      },
      this.deps.logger?.child(`harness-${preset.category}`),
    );

    run.runners.add(runner);
    try {
      await runner.run();
    } finally {
      run.runners.delete(runner);
    }
    return {
      result,
      usage,
      costUsd,
      ...(error !== undefined ? { error } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }
}

/** The per-run user prompt for a convention pass. The whole repo is always scanned
 *  (conventions are repo-wide), so there is no scope branch. The deterministic
 *  profile + top-level inventory are injected so the lens starts from a known map
 *  instead of re-discovering the same structure on every pass. */
function buildCategoryPrompt(
  command: StartHarnessScan,
  preset: HarnessPreset,
  profile: RepoProfile,
  inventory: string,
): string {
  return [
    `You are auditing the CONVENTIONS of the project at: ${command.projectPath}`,
    `Convention lens: ${preset.label}.`,
    '',
    'REPO PROFILE (deterministically detected — start from this, do not re-derive it):',
    summarizeProfile(profile),
    '',
    'REPO MAP (deterministic top-level inventory):',
    inventory,
    '',
    'Using the profile + map above, read the config, the entry points, and a ' +
      'representative sample of files for THIS lens — do not spend turns re-listing ' +
      'the tree — then identify the de-facto conventions and the gaps for this lens.',
    '',
    conventionOutputContract(MAX_FINDINGS_PER_CATEGORY),
  ].join('\n');
}

/** Accumulate token usage in place. */
function addUsage(into: TokenUsage, add: TokenUsage | undefined): void {
  if (add === undefined) return;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheCreationTokens += add.cacheCreationTokens;
}
