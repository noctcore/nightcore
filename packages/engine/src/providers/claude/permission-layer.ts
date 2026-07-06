import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import type { PermissionPolicy, ToolRisk } from '@nightcore/contracts';
import { createRequestIdFactory, type Logger } from '@nightcore/shared';

import { ASK_USER_QUESTION_TOOL } from './question-layer.js';

/** Look up a tool's declared risk class by the name the model uses. Returns
 *  `undefined` when no descriptor declares one — treated as `dangerous`. */
export type RiskLookup = (toolName: string) => ToolRisk | undefined;

/**
 * A pending interactive approval. The PermissionLayer hands the request out to
 * the surface (via `onPrompt`) and parks a promise resolver keyed by requestId;
 * the SessionRunner resolves it when an `approve-permission` command arrives.
 */
interface PendingApproval {
  resolve: (result: PermissionResult) => void;
  /** Original tool input, echoed back as `updatedInput` when the surface allows
   *  without rewriting it — the SDK's allow result REQUIRES `updatedInput`
   *  (omitting it fails control-request validation with a ZodError, which the
   *  model surfaces as e.g. an "ExitPlanMode internal error"). */
  input: Record<string, unknown>;
}

export interface PermissionPromptRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Risk class of the requested tool, threaded onto the emitted event. */
  risk?: ToolRisk;
  title?: string;
}

/** Decision the surface sends back for a pending approval. */
export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * Implements the SDK's `canUseTool` callback. Resolution order per request:
 *   1. explicit deny list                       → deny immediately
 *   2. `dangerous` (or unknown/absent risk) tool
 *      NOT in the explicit allow list           → always prompt + await surface
 *   3. explicit allow list                       → allow immediately
 *   4. otherwise                                 → emit `permission-required`
 *
 * Step 2 guarantees shell exec (and any tool whose risk we can't establish) is
 * never auto-allowed by a broad allow heuristic — even though the SDK only
 * consults `canUseTool` for calls the mode would prompt on, an over-eager
 * mode/allow combination must not silently grant arbitrary effect.
 *
 * Note: this layer is the harness-level policy gate. The SDK's own
 * `permissionMode` (plan / acceptEdits / bypassPermissions / …) still applies
 * underneath; `canUseTool` is only consulted for calls the mode would prompt on.
 */
export class PermissionLayer {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly nextRequestId = createRequestIdFactory('perm');

  constructor(
    private readonly policy: PermissionPolicy,
    private readonly onPrompt: (req: PermissionPromptRequest) => void,
    private readonly riskOf: RiskLookup = () => undefined,
    private readonly logger?: Logger,
  ) {}

  /** The callback wired into the SDK `query()` options. */
  readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    // AskUserQuestion carries no side effect — its interactive answer is
    // collected over the SDK `onUserDialog` channel (QuestionLayer), not here.
    // Auto-allow so it never surfaces as a generic allow/deny prompt with no
    // answers (the bug this feature fixes); the dialog is what the user answers.
    if (toolName === ASK_USER_QUESTION_TOOL) {
      return { behavior: 'allow', updatedInput: input };
    }

    if (this.policy.deny.includes(toolName)) {
      return {
        behavior: 'deny',
        message: `Tool "${toolName}" is denied by Nightcore policy.`,
      };
    }

    const risk = this.riskOf(toolName);
    const isAllowed = this.policy.allow.includes(toolName);

    // A dangerous tool (or one whose risk we can't establish) always prompts
    // unless explicitly allow-listed — never auto-allowed by the steps below.
    const dangerous = risk === 'dangerous' || risk === undefined;
    if (dangerous && !isAllowed) {
      return this.prompt(toolName, input, risk, options);
    }

    if (isAllowed) {
      return { behavior: 'allow', updatedInput: input };
    }

    return this.prompt(toolName, input, risk, options);
  };

  /** Park an interactive approval and hand the request to the surface. */
  private prompt(
    toolName: string,
    input: Record<string, unknown>,
    risk: ToolRisk | undefined,
    options: { signal: AbortSignal; title?: string },
  ): Promise<PermissionResult> {
    const requestId = this.nextRequestId();
    this.logger?.debug('awaiting interactive approval', { requestId, toolName });

    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, input });

      // If the SDK aborts the query while we're parked, settle as a deny so the
      // promise never dangles (mirrors degrade-not-throw).
      options.signal.addEventListener(
        'abort',
        () => this.settleAborted(requestId),
        { once: true },
      );

      this.onPrompt({ requestId, toolName, input, risk, title: options.title });
    });
  }

  /** Resolve a parked approval from a surface `approve-permission` command.
   *  Returns false if the requestId is unknown (already settled / stale). */
  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(
      decision.behavior === 'allow'
        ? // Always send `updatedInput`: default to the original input when the
          // surface approved without rewriting it (the SDK rejects an allow with
          // no `updatedInput`).
          { behavior: 'allow', updatedInput: decision.updatedInput ?? entry.input }
        : { behavior: 'deny', message: decision.message },
    );
    return true;
  }

  /** Deny every pending approval — used when the session tears down so no SDK
   *  control request is left hanging. */
  failAllPending(): void {
    for (const [requestId, entry] of this.pending) {
      entry.resolve({
        behavior: 'deny',
        message: 'Session ended before approval was granted.',
      });
      this.logger?.debug('failed pending approval on teardown', { requestId });
    }
    this.pending.clear();
  }

  private settleAborted(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.resolve({ behavior: 'deny', message: 'Aborted.' });
  }
}
