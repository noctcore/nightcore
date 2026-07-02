/**
 * The Insight analysis orchestrator. A thin {@link ScanManager} subclass: it fans
 * out one READ-ONLY Claude pass per category (bounded-concurrent — honestly
 * parallel, unlike Aperant's sequential-but-labeled-parallel loop), parses + grounds
 * each pass's findings via the pure helpers, streams `analysis-*` events, then
 * de-dups across categories and emits a final `analysis-completed`. The category
 * sub-sessions are INTERNAL: their ordinary session events are consumed by the base
 * runner and never reach the main event stream — only `analysis-*` events do.
 *
 * All the run mechanics (active-run registry, bounded pool, per-item corrective
 * retry, `runOneSession`, usage accumulation, cancel/crash handling) live once in
 * {@link ScanManager} under `../shared/scan-manager.js`; this class injects only the
 * Insight-specific pieces below — a sibling of the Harness / Scorecard managers, each
 * of which lives in its own feature folder.
 */
import type {
  Finding,
  FindingCategory,
  SurfaceCommand,
} from '@nightcore/contracts';

import {
  dedupeFindings,
  groundFindings,
  parseFindings,
} from '../shared/findings.js';
import {
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS,
  type AnalysisPreset,
  analysisPreset,
  ANALYZER_PERSONA,
  outputContract,
} from '../shared/presets.js';
import {
  DEFAULT_MAX_TURNS,
  type FinalizeArgs,
  fmtCost,
  fmtElapsed,
  fmtSecs,
  type ItemCompletedArgs,
  type ScanFailureReason,
  ScanManager,
  type ScanManagerDeps,
  type ScanRunnerFactory,
  type ScanSessionRunner,
  type SessionConfigParts,
} from '../shared/scan-manager.js';

/** The `start-analysis` command variant (the zod schema is exported as a value, so
 *  the engine narrows the union for the type). */
type StartAnalysis = Extract<SurfaceCommand, { type: 'start-analysis' }>;

/** Findings cap per category pass. */
const MAX_FINDINGS_PER_CATEGORY = 8;

/** The runner factory + slice the orchestrator drives, re-exported under Insight-facing
 *  names: `AnalysisManagerDeps` is part of the package's public API (see `index.ts`)
 *  and the aliases keep the Insight test reading in this feature's vocabulary. Harness /
 *  Scorecard import the generic names straight from `../shared/scan-manager.js`. */
export type AnalysisSessionRunner = ScanSessionRunner;
export type AnalysisRunnerFactory = ScanRunnerFactory;
export type AnalysisManagerDeps = ScanManagerDeps;

export class AnalysisManager extends ScanManager<
  StartAnalysis,
  FindingCategory,
  AnalysisPreset,
  Finding
> {
  protected items(command: StartAnalysis): readonly FindingCategory[] {
    return command.categories;
  }

  protected preset(category: FindingCategory): AnalysisPreset {
    return analysisPreset(category);
  }

  protected sessionConfig(
    command: StartAnalysis,
    preset: AnalysisPreset,
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

  protected heartbeatLabel(preset: AnalysisPreset): string {
    return `[insight:${preset.category}]`;
  }

  protected buildPrompt(
    command: StartAnalysis,
    preset: AnalysisPreset,
    _context: Record<string, never>,
    inventory: string,
  ): string {
    return buildCategoryPrompt(command, preset, inventory);
  }

  protected parse(
    result: string,
    category: FindingCategory,
  ): { findings: Finding[]; error?: string } {
    return parseFindings(result, category);
  }

  protected ground(findings: Finding[], projectPath: string): Finding[] {
    return groundFindings(findings, projectPath);
  }

  protected retryReminderSuffix(): string {
    return '\n\nIMPORTANT: your previous answer was not valid JSON. Respond with ONLY the JSON array, nothing else.';
  }

  protected emitStarted(command: StartAnalysis, model: string): void {
    this.deps.emit({
      type: 'analysis-started',
      runId: command.runId,
      scope: command.scope,
      categories: command.categories,
      model,
    });
    this.deps.logger?.info(
      `[insight] scan started — ${command.categories.length} categories · model ${model} · scope ${command.scope}`,
    );
  }

  protected emitItemStarted(
    command: StartAnalysis,
    category: FindingCategory,
  ): void {
    this.deps.emit({
      type: 'analysis-category-started',
      runId: command.runId,
      category,
    });
    this.deps.logger?.info(`[insight] category ${category}: started`);
  }

  protected emitItemCompleted(
    args: ItemCompletedArgs<StartAnalysis, FindingCategory, Finding>,
  ): void {
    const { command, item: category, grounded, outcome, elapsedMs } = args;
    this.deps.emit({
      type: 'analysis-category-completed',
      runId: command.runId,
      category,
      findings: grounded,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
    this.deps.logger?.info(
      `[insight] category ${category}: completed — ${grounded.length} findings, ${fmtCost(outcome.costUsd)}, ${fmtSecs(elapsedMs)}`,
    );
  }

  protected async finalize(
    args: FinalizeArgs<StartAnalysis, FindingCategory, Finding, Record<string, never>>,
  ): Promise<void> {
    const { command, findings, itemsRun, totalCost, totalUsage, startedAt } = args;
    const deduped = dedupeFindings(findings);
    const durationMs = Date.now() - startedAt;
    this.deps.emit({
      type: 'analysis-completed',
      runId: command.runId,
      findings: deduped,
      categoriesRun: itemsRun,
      costUsd: totalCost,
      durationMs,
      usage: totalUsage,
    });
    this.deps.logger?.info(
      `[insight] scan completed — ${deduped.length} findings across ${itemsRun.length} categories, ${fmtCost(totalCost)}, ${fmtElapsed(durationMs)}`,
    );
  }

  protected emitFailed(
    command: StartAnalysis,
    reason: ScanFailureReason,
    message: string,
  ): void {
    this.deps.emit({
      type: 'analysis-failed',
      runId: command.runId,
      reason,
      message,
    });
  }

  protected cancelledMessage(): string {
    return 'analysis cancelled';
  }
}

/** The per-run user prompt for a category pass. The deterministic top-level
 *  `inventory` is injected so the pass targets its reads from a known map instead of
 *  re-listing the tree (cuts redundant exploration turns). */
function buildCategoryPrompt(
  command: StartAnalysis,
  preset: AnalysisPreset,
  inventory: string,
): string {
  const scopeLine =
    command.scope === 'diff' &&
    command.changedFiles !== undefined &&
    command.changedFiles.length > 0
      ? `Focus your analysis ONLY on these recently changed files and the code they directly touch:\n${command.changedFiles
          .map((f) => `- ${f}`)
          .join('\n')}`
      : 'Analyze the whole repository. Use the repo map above to target the entry points and the most relevant areas, then drill into where issues are most likely — do not spend turns re-listing the tree.';

  return [
    `You are analyzing the project at: ${command.projectPath}`,
    `Category: ${preset.label}.`,
    '',
    'REPO MAP (deterministic top-level inventory — start here):',
    inventory,
    '',
    scopeLine,
    '',
    outputContract(MAX_FINDINGS_PER_CATEGORY),
  ].join('\n');
}
