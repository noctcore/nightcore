/**
 * Assembles a `SessionRunner`'s guard collaborators from its config: the
 * PreToolUse {@link HookBus}, the interactive {@link PermissionLayer}, and the
 * {@link QuestionLayer}. Factored out of the runner's constructor so the wiring —
 * and the request→event mapping each layer emits through — is nameable and
 * unit-testable on its own.
 */
import type { NightcoreEvent } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { ToolRegistry } from '../../policy/tool-registry.js';
import type { SessionLedger } from '../../util/session-ledger.js';
import { HookBus } from './hook-bus.js';
import { PermissionLayer } from './permission-layer.js';
import { QuestionLayer } from './question-layer.js';
import type { SessionRunnerConfig } from './session-options.js';

export interface SessionGuards {
  readonly hooks: HookBus;
  readonly permissions: PermissionLayer;
  readonly questions: QuestionLayer;
}

/**
 * Build the guard trio for one session.
 *
 * The {@link HookBus} confines file mutations to the run cwd (worktree isolation)
 * and enforces the project's harness runtime policy (protected paths + Bash deny
 * patterns) — the PreToolUse gate enforces both even under `bypassPermissions`.
 * When a `ledger` is present, the flight recorder rides the same gate's decision
 * seam (one writer sees every allow AND deny). The {@link PermissionLayer} and
 * {@link QuestionLayer} translate a parked request into the wire event the
 * supervisor forwards.
 */
export function createSessionGuards(
  cfg: SessionRunnerConfig,
  emit: (event: NightcoreEvent) => void,
  ledger: SessionLedger | undefined,
  logger?: Logger,
): SessionGuards {
  const registry = new ToolRegistry();
  const hooks = new HookBus(logger, {
    cwd: cfg.cwd,
    ...(cfg.harnessPolicy !== undefined
      ? { harnessPolicy: cfg.harnessPolicy }
      : {}),
    ...(ledger !== undefined
      ? { onToolDecision: ledger.recordToolDecision }
      : {}),
  });
  const permissions = new PermissionLayer(
    cfg.permissionPolicy,
    (req) =>
      emit({
        type: 'permission-required',
        sessionId: cfg.sessionId,
        requestId: req.requestId,
        toolName: req.toolName,
        input: req.input,
        risk: req.risk,
        title: req.title,
      }),
    (name) => registry.riskOf(name),
    logger,
  );
  const questions = new QuestionLayer(
    (req) =>
      emit({
        type: 'question-required',
        sessionId: cfg.sessionId,
        requestId: req.requestId,
        ...(req.toolUseId !== undefined ? { toolUseId: req.toolUseId } : {}),
        questions: req.questions,
      }),
    logger,
  );
  return { hooks, permissions, questions };
}
