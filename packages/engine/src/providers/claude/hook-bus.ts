import type {
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';

import type { HarnessPolicy } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import {
  type CompiledExecSinkGate,
  compileExecSinkGate,
  evaluateExecSinkGate,
} from '../../policy/exec-sink.js';
import {
  type CompiledHarnessPolicy,
  compileHarnessPolicy,
  evaluateHarnessPolicy,
  type HarnessPolicyVerdict,
} from '../../policy/harness-policy.js';
import {
  DEFAULT_DESTRUCTIVE_RULES,
  evaluateToolDeny,
  type ToolDenyRule,
  type ToolDenyVerdict,
} from '../../policy/tool-deny-policy.js';
import { evaluateWorkspaceConfinement } from '../../policy/workspace-confinement.js';

/**
 * Registers a small set of SDK hooks and re-emits them to local observers.
 *
 * `PreToolUse` is also a **blocking enforcement gate**: it evaluates each tool
 * call against (1) a safe default destructive-command deny list, (2) the
 * workspace-confinement gate — a file mutation that resolves outside the run
 * `cwd` — (3) the project's harness runtime policy (protected paths + Bash
 * deny patterns + tool deny/ask tiers from `.nightcore/harness.json`), and
 * (4) the built-in execution-sink gate — a write to a path that changes how
 * code executes (CI, git/Claude hooks, package scripts) — and returns a
 * `permissionDecision: 'deny'` for a deny match or `permissionDecision: 'ask'`
 * for an `askTools`/exec-sink match (escalated to the host's `canUseTool` by the
 * CLI, even under bypass). The exec-sink gate runs LAST so a hard deny always
 * wins and it can never downgrade a deny to an ask. Crucially, SDK hooks fire
 * **regardless of `permissionMode`** — including `bypassPermissions`, where the
 * `canUseTool` permission layer is never consulted for ordinary calls — so this
 * is the one guardrail that contains the studio's default unattended config. See
 * {@link DEFAULT_DESTRUCTIVE_RULES}, {@link evaluateWorkspaceConfinement}, and
 * {@link evaluateHarnessPolicy} for scope and limits (heuristic, not a sandbox).
 * `SessionStart` stays a pure non-blocking observer.
 *
 * Local plugins subscribe via `on()` to react to lifecycle events.
 */
export class HookBus {
  private readonly observers = new Set<(event: HookEvent, input: unknown) => void>();

  /** The run's working directory. When set, the PreToolUse gate ALSO confines
   *  file mutations to it (worktree isolation); undefined ⇒ confinement is off. */
  private readonly cwd?: string;
  /** The destructive-command deny rules the PreToolUse gate enforces. Injectable
   *  so a future workspace-trust gate can widen the set (e.g. WebFetch off) for
   *  an untrusted repo; defaults to the studio's safe baseline. */
  private readonly denyRules: readonly ToolDenyRule[];
  /** The project's harness runtime policy (module #3), compiled once for the
   *  session. Undefined ⇒ no policy layer (no manifest / disabled). */
  private readonly harnessPolicy?: CompiledHarnessPolicy;
  /** The built-in execution-sink ask gate (issue #142), compiled once for the
   *  session. ALWAYS armed (independent of a harness manifest) — it enforces
   *  under the studio's default unattended config — with the project's
   *  `allowExecSinks` downgrade list folded in (empty when there's no policy). */
  private readonly execSinkGate: CompiledExecSinkGate;
  /** Observer of every PreToolUse gate evaluation (the session flight-recorder
   *  seam, module #5): called with the tool, its raw input, and the gate's
   *  decision (+ the matched rule id on deny). Purely observational — a throw
   *  here is swallowed (fail-open) and never blocks the tool call. */
  private readonly onToolDecision?: (
    tool: string,
    input: unknown,
    decision: 'allow' | 'deny' | 'ask',
    ruleId?: string,
  ) => void;

  constructor(
    private readonly logger?: Logger,
    opts?: {
      /** The run cwd to confine file mutations to (worktree isolation). */
      cwd?: string;
      /** Override the destructive-command deny rules (defaults to the baseline). */
      denyRules?: readonly ToolDenyRule[];
      /** The project's harness runtime policy (protected paths + Bash deny
       *  patterns), resolved by the Rust core from `.nightcore/harness.json` and
       *  carried on `start-session`. Path rules need `cwd` to resolve against;
       *  Bash rules enforce regardless. */
      harnessPolicy?: HarnessPolicy;
      /** Flight-recorder observer for every gate evaluation (see the field). */
      onToolDecision?: (
        tool: string,
        input: unknown,
        decision: 'allow' | 'deny' | 'ask',
        ruleId?: string,
      ) => void;
    },
  ) {
    this.cwd = opts?.cwd;
    this.denyRules = opts?.denyRules ?? DEFAULT_DESTRUCTIVE_RULES;
    if (opts?.harnessPolicy !== undefined) {
      this.harnessPolicy = compileHarnessPolicy(opts.harnessPolicy, logger);
    }
    // Always armed: the exec-sink gate must bite even for a project with no
    // harness manifest (the default). Only the per-project `allowExecSinks`
    // downgrade list comes from the policy (empty when absent).
    this.execSinkGate = compileExecSinkGate(opts?.harnessPolicy?.allowExecSinks);
    this.onToolDecision = opts?.onToolDecision;
  }

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

    // (1) Destructive-command deny list (rm -rf, force-push, …).
    const destructive = evaluateToolDeny(tool_name, tool_input, this.denyRules);
    if (destructive.denied) return this.denyOutput(tool_name, tool_input, destructive);

    // (2) Workspace confinement — a file mutation outside the run cwd. Only when a
    // cwd is set (a real session always has one; probes/tests may omit it).
    if (this.cwd !== undefined) {
      const confinement = evaluateWorkspaceConfinement(
        tool_name,
        tool_input,
        this.cwd,
      );
      if (confinement.denied) return this.denyOutput(tool_name, tool_input, confinement);
    }

    // (3) Harness runtime policy — the project's declared protected paths + Bash
    // deny patterns. AFTER confinement so its fail-closed unreadable-target denial
    // owns that shape (the policy gate deliberately leaves it alone); Bash rules
    // enforce even without a cwd. The evaluator runs its ask tier only when no
    // deny tier matched (deny wins over ask, inside this hook and across hooks —
    // the SDK merges multiple hooks' decisions as deny > ask > allow).
    if (this.harnessPolicy !== undefined) {
      const policy = evaluateHarnessPolicy(
        tool_name,
        tool_input,
        this.harnessPolicy,
        this.cwd,
      );
      if (policy.denied) return this.denyOutput(tool_name, tool_input, policy);
      if (policy.ask === true) return this.askOutput(tool_name, tool_input, policy);
    }

    // (4) Execution-sink write protection (issue #142) — a write to a path that
    // changes how code executes (CI, git/Claude/husky hooks, package scripts) is
    // escalated to an interactive ask, even under bypass. Runs LAST so every deny
    // tier above wins: an out-of-cwd exec-sink write is already DENIED by
    // confinement (2) and a `protectedPaths` sink by the harness policy (3), so
    // this ask can never downgrade a deny. Always armed (independent of a
    // manifest); a project softens specific sinks via `allowExecSinks`.
    if (this.cwd !== undefined) {
      const execSink = evaluateExecSinkGate(
        tool_name,
        tool_input,
        this.cwd,
        this.execSinkGate,
      );
      if (execSink.ask === true) return this.askOutput(tool_name, tool_input, execSink);
    }

    this.recordDecision(tool_name, tool_input, 'allow');
    return undefined;
  }

  /** Feed the flight-recorder seam, fail-open: an observer error is warned and
   *  swallowed so recording can never block (or fail) a tool call. */
  private recordDecision(
    tool: string,
    input: unknown,
    decision: 'allow' | 'deny' | 'ask',
    ruleId?: string,
  ): void {
    if (this.onToolDecision === undefined) return;
    try {
      this.onToolDecision(tool, input, decision, ruleId);
    } catch (error) {
      this.logger?.warn('tool-decision observer threw', error);
    }
  }

  /** Build the `PreToolUse` deny output for a matched verdict — denies THIS call
   *  (the session keeps running so the agent can adapt), never `continue: false`. */
  private denyOutput(
    toolName: string,
    toolInput: unknown,
    verdict: ToolDenyVerdict,
  ): HookJSONOutput {
    this.recordDecision(toolName, toolInput, 'deny', verdict.ruleId);
    this.logger?.warn('blocked tool call', {
      toolName,
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

  /** Build the `PreToolUse` ask output for an `askTools` match — escalates THIS
   *  call to an interactive permission ask. The CLI forwards an 'ask' hook
   *  decision to the host's `canUseTool` even under `bypassPermissions` (the
   *  hook pre-decision short-circuits the mode pipeline's auto-allow), which is
   *  what makes the ask tier hold in the studio's default unattended config. */
  private askOutput(
    toolName: string,
    toolInput: unknown,
    verdict: HarnessPolicyVerdict,
  ): HookJSONOutput {
    this.recordDecision(toolName, toolInput, 'ask', verdict.ruleId);
    this.logger?.info('escalating tool call to interactive approval', {
      toolName,
      ruleId: verdict.ruleId,
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason:
          verdict.reason ?? 'This project requires approval for this tool.',
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
