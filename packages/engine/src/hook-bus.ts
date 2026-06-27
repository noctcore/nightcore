import type {
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@nightcore/shared';
import {
  evaluateToolDeny,
  DEFAULT_DESTRUCTIVE_RULES,
  type ToolDenyRule,
} from './tool-deny-policy.js';

/**
 * Registers a small set of SDK hooks and re-emits them to local observers.
 *
 * `PreToolUse` is also a **blocking enforcement gate**: it evaluates each tool
 * call against a safe default destructive-command deny list and returns a
 * `permissionDecision: 'deny'` for a match. Crucially, SDK hooks fire
 * **regardless of `permissionMode`** — including `bypassPermissions`, where the
 * `canUseTool` permission layer is never consulted — so this is the one guardrail
 * that contains the studio's default unattended config. See
 * {@link DEFAULT_DESTRUCTIVE_RULES} for scope and limits (heuristic, not a
 * sandbox). `SessionStart` stays a pure non-blocking observer.
 *
 * Local plugins subscribe via `on()` to react to lifecycle events.
 */
export class HookBus {
  private readonly observers = new Set<(event: HookEvent, input: unknown) => void>();

  constructor(
    private readonly logger?: Logger,
    /** The destructive-command deny rules the PreToolUse gate enforces. Injectable
     *  so a future workspace-trust gate can widen the set (e.g. WebFetch off) for
     *  an untrusted repo; defaults to the studio's safe baseline. */
    private readonly denyRules: readonly ToolDenyRule[] = DEFAULT_DESTRUCTIVE_RULES,
  ) {}

  /** Subscribe to all observed hook events. Returns an unsubscribe fn. */
  on(observer: (event: HookEvent, input: unknown) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  private emit(event: HookEvent, input: unknown): void {
    for (const observer of this.observers) {
      try {
        observer(event, input);
      } catch (error) {
        this.logger?.warn('hook observer threw', error);
      }
    }
  }

  /**
   * Decide a `PreToolUse` call: deny (with a reason the agent sees) when the tool
   * call matches the destructive deny list, else return `undefined` ("no opinion")
   * so the caller emits the plain `{ continue: true }`.
   *
   * `permissionDecision: 'deny'` denies just THIS tool call (the session keeps
   * running and the agent can adapt) — it deliberately does NOT set
   * `continue: false`, which would abort the whole session.
   */
  private decidePreToolUse(input: unknown): HookJSONOutput | undefined {
    if (input === null || typeof input !== 'object') return undefined;
    const { tool_name, tool_input } = input as {
      tool_name?: unknown;
      tool_input?: unknown;
    };
    if (typeof tool_name !== 'string') return undefined;

    const verdict = evaluateToolDeny(tool_name, tool_input, this.denyRules);
    if (!verdict.denied) return undefined;

    this.logger?.warn('blocked destructive tool call', {
      toolName: tool_name,
      ruleId: verdict.ruleId,
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          verdict.reason ?? 'Blocked by Nightcore safety policy.',
      },
    };
  }

  /** The `hooks` map for SDK `Options`. `SessionStart` is observation-only;
   *  `PreToolUse` observes AND enforces the destructive deny list. */
  hooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const observe = (event: HookEvent): HookCallbackMatcher => ({
      hooks: [
        async (input) => {
          this.emit(event, input);
          return { continue: true };
        },
      ],
    });

    const preToolUse: HookCallbackMatcher = {
      hooks: [
        async (input) => {
          // Observe first (audit/telemetry seam), then enforce.
          this.emit('PreToolUse', input);
          return this.decidePreToolUse(input) ?? { continue: true };
        },
      ],
    };

    return {
      PreToolUse: [preToolUse],
      SessionStart: [observe('SessionStart')],
    };
  }
}
