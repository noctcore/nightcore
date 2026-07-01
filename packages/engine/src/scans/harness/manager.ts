/**
 * The Harness scan orchestrator. A {@link ScanManager} subclass that adds the two
 * hops over Insight/Scorecard: a `prepare` step that detects the deterministic repo
 * profile and emits `harness-profile-ready` up front (no session), and a `finalize`
 * step that dedups the convention findings, runs ONE synthesis pass proposing
 * enforceable artifacts (`harness-synthesis-started` → `harness-proposals-ready`),
 * then emits the terminal `harness-scan-completed`. The per-lens fan-out itself is
 * the generic pool inherited from the base. The lens + synthesis sub-sessions are
 * INTERNAL: their ordinary session events are consumed by the base runner and never
 * reach the main event stream — only `harness-*` events do.
 *
 * Degrade-not-throw throughout (inherited from the base): any crash surfaces as a
 * `harness-scan-failed` event, never a rejected promise; a synthesis failure degrades
 * to zero artifacts (a scan with findings is still useful).
 */
import type {
  ConventionCategory,
  ConventionFinding,
  ProposedArtifact,
  RepoProfile,
  SurfaceCommand,
} from '@nightcore/contracts';
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
import {
  addUsage,
  DEFAULT_MAX_TURNS,
  fmtCost,
  fmtElapsed,
  fmtSecs,
  ScanManager,
  type FinalizeArgs,
  type ItemCompletedArgs,
  type ScanManagerDeps,
  type ScanFailureReason,
  type ScanRunnerFactory,
  type ScanSessionRunner,
  type SessionConfigParts,
} from '../shared/scan-manager.js';

/** The `start-harness-scan` command variant (the zod schema is exported as a value,
 *  so the engine narrows the union for the type). */
type StartHarnessScan = Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

/** Findings cap per convention pass. */
const MAX_FINDINGS_PER_CATEGORY = 8;

/** The runner factory + slice — REUSED from the generic base so the managers share
 *  one fake-runner injection shape in tests. */
export type HarnessRunnerFactory = ScanRunnerFactory;
export type HarnessSessionRunner = ScanSessionRunner;
export type HarnessManagerDeps = ScanManagerDeps;

/** The pre-fanout context Harness derives: the deterministic repo profile, reused by
 *  every lens prompt and the synthesis pass. */
interface HarnessContext {
  profile: RepoProfile;
}

export class HarnessManager extends ScanManager<
  StartHarnessScan,
  ConventionCategory,
  HarnessPreset,
  ConventionFinding,
  HarnessContext
> {
  protected items(command: StartHarnessScan): readonly ConventionCategory[] {
    return command.categories;
  }

  /** Deterministic profile first — a cheap fs pass, no session — emitted before the
   *  fan-out so the UI + every lens prompt can start from it. */
  protected async prepare(
    command: StartHarnessScan,
  ): Promise<HarnessContext> {
    const profile = detectRepoProfile(command.projectPath);
    this.deps.emit({
      type: 'harness-profile-ready',
      runId: command.runId,
      profile,
    });
    this.deps.logger?.info(
      `[harness] profile detected — ${profile.isMonorepo ? `monorepo (${profile.workspaceTool})` : 'single package'} · ${profile.packages.length} packages · ${profile.languages.join('/') || 'unknown'}`,
    );
    return { profile };
  }

  protected preset(category: ConventionCategory): HarnessPreset {
    return harnessPreset(category);
  }

  protected sessionConfig(
    command: StartHarnessScan,
    preset: HarnessPreset,
  ): SessionConfigParts {
    return {
      appendSystemPrompt: `${ANALYZER_PERSONA} For this pass, look for: ${preset.focus}`,
      allowedTools: [...ANALYSIS_ALLOWED_TOOLS],
      disallowedTools: [...ANALYSIS_DISALLOWED_TOOLS],
      maxTurns: command.maxTurnsPerCategory ?? DEFAULT_MAX_TURNS,
      ...(command.maxBudgetUsdPerCategory !== undefined
        ? { maxBudgetUsd: command.maxBudgetUsdPerCategory }
        : {}),
    };
  }

  protected heartbeatLabel(preset: HarnessPreset): string {
    return `[harness:${preset.category}]`;
  }

  protected buildPrompt(
    command: StartHarnessScan,
    preset: HarnessPreset,
    context: HarnessContext,
    inventory: string,
  ): string {
    return buildCategoryPrompt(command, preset, context.profile, inventory);
  }

  protected parse(
    result: string,
    category: ConventionCategory,
  ): { findings: ConventionFinding[]; error?: string } {
    return parseConventionFindings(result, category);
  }

  protected ground(
    findings: ConventionFinding[],
    projectPath: string,
  ): ConventionFinding[] {
    return groundConventionFindings(findings, projectPath);
  }

  protected retryReminderSuffix(): string {
    return '\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON array, nothing else.';
  }

  protected emitStarted(command: StartHarnessScan, model: string): void {
    this.deps.emit({
      type: 'harness-scan-started',
      runId: command.runId,
      categories: command.categories,
      model,
    });
    this.deps.logger?.info(
      `[harness] scan started — ${command.categories.length} lenses · model ${model}`,
    );
  }

  protected emitItemStarted(
    command: StartHarnessScan,
    category: ConventionCategory,
  ): void {
    this.deps.emit({
      type: 'harness-category-started',
      runId: command.runId,
      category,
    });
    this.deps.logger?.info(`[harness] lens ${category}: started`);
  }

  protected emitItemCompleted(
    args: ItemCompletedArgs<StartHarnessScan, ConventionCategory, ConventionFinding>,
  ): void {
    const { command, item: category, grounded, outcome, elapsedMs } = args;
    this.deps.emit({
      type: 'harness-category-completed',
      runId: command.runId,
      category,
      findings: grounded,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
    this.deps.logger?.info(
      `[harness] lens ${category}: completed — ${grounded.length} findings, ${fmtCost(outcome.costUsd)}, ${fmtSecs(elapsedMs)}`,
    );
  }

  /** Dedup → synthesize (proposes the enforceable artifacts) → complete. A late
   *  cancel (mid-synthesis) surfaces `harness-scan-failed`; a synthesis failure
   *  degrades to zero artifacts. `totalUsage` is mutated in place to fold in the
   *  synthesis usage; `totalCost` is a local sum. */
  protected async finalize(
    args: FinalizeArgs<
      StartHarnessScan,
      ConventionCategory,
      ConventionFinding,
      HarnessContext
    >,
  ): Promise<void> {
    const {
      command,
      run,
      findings,
      itemsRun,
      totalUsage,
      startedAt,
      context,
      inventory,
    } = args;
    let totalCost = args.totalCost;
    const deduped = dedupeConventionFindings(findings);

    // Synthesis: one read-only pass that proposes the harness artifacts. A failure
    // degrades to no proposals — a scan with findings is still useful. Announce the
    // start so the UI swaps the all-lenses-done dead zone for a "Synthesizing
    // harness…" state and the terminal marks the (serial) tail.
    this.deps.emit({ type: 'harness-synthesis-started', runId: command.runId });
    this.deps.logger?.info(
      `[harness] synthesis: started — ${deduped.length} findings to enforce`,
    );
    const synthesisStartedAt = Date.now();
    let artifacts: ProposedArtifact[] = [];
    const synthesis = await synthesizeHarness({
      profile: context.profile,
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
      this.emitFailed(command, 'aborted', this.cancelledMessage());
      return;
    }

    this.deps.emit({
      type: 'harness-proposals-ready',
      runId: command.runId,
      artifacts,
    });

    const durationMs = Date.now() - startedAt;
    this.deps.emit({
      type: 'harness-scan-completed',
      runId: command.runId,
      profile: context.profile,
      findings: deduped,
      artifacts,
      categoriesRun: itemsRun,
      costUsd: totalCost,
      durationMs,
      usage: totalUsage,
    });
    this.deps.logger?.info(
      `[harness] scan completed — ${deduped.length} findings, ${artifacts.length} proposals across ${itemsRun.length} lenses, ${fmtCost(totalCost)}, ${fmtElapsed(durationMs)}`,
    );
  }

  protected emitFailed(
    command: StartHarnessScan,
    reason: ScanFailureReason,
    message: string,
  ): void {
    this.deps.emit({
      type: 'harness-scan-failed',
      runId: command.runId,
      reason,
      message,
    });
  }

  protected cancelledMessage(): string {
    return 'harness scan cancelled';
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
