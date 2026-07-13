/**
 * Builds the Claude Agent SDK `Options` for one Nightcore session — auth, env
 * allowlist, kind preset, context pack, autonomy ceilings and external MCP
 * servers — composed away from the `SessionRunner` so the option-construction
 * logic is unit-testable without spinning a `query()`.
 *
 * Two surfaces:
 *  - [`SessionOptionsBuilder.base`] — the options shared by the main run loop and
 *    the transient control probes (`withProbe`);
 *  - [`SessionOptionsBuilder.run`] — the full options for the main `query()`,
 *    layered on top of `base()` with the per-run knobs (model, permission mode,
 *    autonomy ceilings, resume, checkpointing) plus the runtime collaborators the
 *    runner owns (`canUseTool` / `onUserDialog` / `hooks` / the abort controller).
 *
 * The pure compose helpers each live in their own module so each translation is
 * testable in isolation (`mcp-server-options.ts`, `user-message-content.ts`,
 * `system-prompt.ts`) and are re-exported here so this stays the single import
 * path callers already use.
 */
import type {
  EffortLevel,
  HarnessPolicy,
  McpServerEntry,
  PermissionMode,
  PermissionPolicy,
  SettingSource,
  TaskKind,
  WireImage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { toSdkMcpServers } from './mcp-server-options.js';
import { resolveClaudeBinary } from './resolve-claude-binary.js';
import type { Options, OutputFormat } from './sdk-adapter.js';
import { buildSubprocessEnv } from './subprocess-env.js';
import { composeAppendSystemPrompt, workingRootDirective } from './system-prompt.js';

export { toSdkMcpServers } from './mcp-server-options.js';
export {
  composeAppendSystemPrompt,
  CONTEXT_PACK_MAX_CHARS,
  workingRootDirective,
} from './system-prompt.js';
export { buildUserMessageContent } from './user-message-content.js';

/** Everything a [`SessionRunner`] needs to construct and drive one SDK query:
 *  the prompt + optional images, model/effort, permission policy, cwd, and the
 *  optional kind-preset / autonomy-ceiling / resume / MCP / context-pack inputs. */
export interface SessionRunnerConfig {
  sessionId: number;
  prompt: string;
  /** Image attachments to include on the FIRST user message as SDK image content
   *  blocks (alongside the prompt text). Absent/empty ⇒ a text-only message
   *  (byte-identical to the pre-feature shape). */
  images?: WireImage[];
  model: string;
  /** Reasoning effort for the session. Fixed at query construction — the SDK has
   *  no live `setEffort()`, so a surface's effort choice applies to the next
   *  session. Omitted = let the model decide. */
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  permissionPolicy: PermissionPolicy;
  cwd: string;
  /** When true, an `ANTHROPIC_API_KEY` is present and used as a fallback. Auth
   *  otherwise flows entirely through the local Claude CLI credentials — the
   *  runner passes NO apiKey itself (see README auth section). */
  apiKeyFallback: boolean;
  /** On-disk settings sources the SDK loads (skills/commands/agents/CLAUDE.md).
   *  Empty = strict isolation (no skills loaded, no `Skill` option set). */
  settingSources: SettingSource[];
  /** Enable the SDK's task/todo tracking. REQUIRED for the `task_*` system
   *  messages (→ `task-updated` events) to be emitted. */
  todoFeatureEnabled: boolean;
  /** The session's task kind (preset selector). Threaded into message
   *  translation so a `decompose` session's final result is parsed into structured
   *  `proposedSubtasks` on the `session-completed` event. Absent ⇒ no per-kind
   *  result post-processing (the `build` shape). */
  kind?: TaskKind;
  /** Appended to the SDK system prompt (kind preset). Omitted = no append. */
  appendSystemPrompt?: string;
  /** SDK-native structured output request (`Options.outputFormat`, kind preset).
   *  Set for `decompose` so the SDK returns a schema-conforming object and retries
   *  non-conforming output internally. Omitted ⇒ a free-form text result. */
  outputFormat?: OutputFormat;
  /** Tools to explicitly allow (kind preset, SDK `allowedTools`). */
  allowedTools?: string[];
  /** Tools to deny (kind preset, SDK `disallowedTools`). */
  disallowedTools?: string[];
  /** Autonomy ceiling: max conversation turns before the SDK stops the query
   *  (`Options.maxTurns`). A hit ceiling returns an `error_max_turns` result →
   *  `session-failed { reason: 'max-turns' }`. Resolved by the manager (per-task
   *  override → config default). */
  maxTurns?: number;
  /** Autonomy ceiling: max spend in USD before the SDK stops the query
   *  (`Options.maxBudgetUsd`). A hit ceiling returns an `error_max_budget_usd`
   *  result → `session-failed { reason: 'max-budget' }`. Omitted ⇒ uncapped.
   *  Resolved by the manager (per-task override → config). */
  maxBudgetUsd?: number;
  /** Resume a prior SDK session by its UUID (`Options.resume`). Set on the
   *  recovery path when a persisted `sdkSessionId` exists. Omitted ⇒ a cold
   *  (fresh) session. */
  resumeSessionId?: string;
  /** External MCP servers to inject for this session (`Options.mcpServers`).
   *  Folded into the SDK options by `name`, ADDITIVELY over the user's native
   *  `.mcp.json`/`~/.claude.json` (we never set `strictMcpConfig`). The Rust core
   *  already filters to `enabled` entries, but `toSdkMcpServers` re-filters
   *  defensively. Absent/empty ⇒ no `mcpServers` key is set. Values in
   *  `env`/`headers` may carry secrets — never logged at info/telemetry. */
  mcpServers?: McpServerEntry[];
  /** Enable SDK file checkpointing (`Options.enableFileCheckpointing`) so the
   *  session's file changes can be rewound via `rewindFiles()`. Off by default. */
  enableFileCheckpointing?: boolean;
  /** A curated, Nightcore-CONTROLLED pre-flight context pack the Rust core
   *  assembled from on-disk sources. Composed into the final `appendSystemPrompt`
   *  BEFORE [`appendSystemPrompt`] (the kind-preset persona) so project rules lead,
   *  then the persona — and truncated to [`CONTEXT_PACK_MAX_CHARS`] so it can't
   *  crowd out the task. Absent/empty ⇒ no pack folded in. */
  appendContextPack?: string;
  /** The project's harness runtime policy (protected paths + Bash deny patterns),
   *  resolved by the Rust core from `.nightcore/harness.json` and enforced by the
   *  session's PreToolUse gate — the layer that holds even under
   *  `bypassPermissions`. Absent ⇒ no policy layer (pre-feature shape). */
  harnessPolicy?: HarnessPolicy;
  /** Session flight recorder (module #5): absolute path of the per-task NDJSON
   *  tool-event ledger the Rust core computed
   *  (`<projectRoot>/.nightcore/ledger/<taskId>.ndjson`) and carried on
   *  `start-session`. The runner appends one record per PreToolUse gate
   *  evaluation plus session start/end markers — append-only, fail-open,
   *  size-capped (see `SessionLedger`). Absent ⇒ no recording. */
  ledgerPath?: string;
  /** OPT-IN macOS OS-level WRITE containment (hardening module #15): the runner
   *  wraps the resolved `claude` executable in a Seatbelt deny-write-except
   *  profile (see `sandbox.ts`) so writes outside the session's workspace are
   *  blocked at the OS layer — closing the lexical PreToolUse gate's documented
   *  gaps (Bash redirects, symlinks). Requested by the Rust core from the
   *  `sandbox_sessions` setting; when requested but unavailable the runner logs
   *  a loud warning and runs UNwrapped (fail-open). Absent ⇒ off. */
  sandboxWrites?: boolean;
  /** Idle watchdog deadline (ms): if the SDK subprocess yields NO message for this
   *  long mid-run, the runner treats the stream as wedged, aborts the subprocess,
   *  and fails the session (`reason: 'runner-crash'`) so the concurrency slot is
   *  released instead of leaking forever. Deliberately GENEROUS — a single long
   *  tool call (a multi-minute build/test) emits no intermediate SDK messages, so
   *  this must clear the longest legitimate quiet gap. Absent ⇒
   *  [`DEFAULT_IDLE_TIMEOUT_MS`]. */
  idleTimeoutMs?: number;
}

/**
 * The runtime collaborators the [`SessionRunner`] owns and threads into the main
 * `run()` options — kept out of [`SessionRunnerConfig`] because they are live
 * objects (the permission/question/hook layers and the abort controller), not
 * serializable config. Each value is assignable to the matching `Options` field.
 */
export interface SessionRunOptionsRuntime {
  /** The PermissionLayer's interactive tool gate (`Options.canUseTool`). */
  canUseTool: Options['canUseTool'];
  /** The QuestionLayer's dialog handler (`Options.onUserDialog`). */
  onUserDialog: Options['onUserDialog'];
  /** The dialog kinds the session opts into receiving (the CLI fails closed on
   *  undeclared kinds). */
  supportedDialogKinds: Options['supportedDialogKinds'];
  /** The HookBus's assembled hook map (`Options.hooks`). */
  hooks: Options['hooks'];
  /** The runner's abort controller, shared so `interrupt()` tears the query down. */
  abortController: AbortController;
}

/**
 * Composes the SDK `Options` for one session from its [`SessionRunnerConfig`].
 * Stateless given the config, so it is constructed once per runner and queried for
 * the shared `base()` options (run loop + transient probes) and the full `run()`
 * options. Holding the option logic here keeps each new session variant (a new
 * kind preset, a resumed/checkpointed session) a change to this builder rather than
 * surgery on the runner's query loop.
 */
export class SessionOptionsBuilder {
  constructor(
    private readonly cfg: SessionRunnerConfig,
    private readonly logger?: Logger,
  ) {}

  /** SDK options shared by the main run loop and the transient model probe. Auth:
   *  never pass an apiKey — the SDK's bundled CLI resolves the user's local Claude
   *  credentials (~/.claude); ANTHROPIC_API_KEY in the env is honored as a
   *  fallback automatically. `pathToClaudeCodeExecutable` is set whenever
   *  `resolveClaudeBinary()` finds a real, on-disk, executable `claude` (the SDK's
   *  own version-pinned binary preferred) — required for the `bun build --compile`
   *  distributable, whose `$bunfs` bundling breaks the SDK's self-resolution; it
   *  stays unset only when nothing verifiable resolves, leaving the SDK's default
   *  resolution in place. */
  base(): Options {
    const claudePath = resolveClaudeBinary();
    const hasSettingSources = this.cfg.settingSources.length > 0;
    // Inject the configured external MCP servers HERE (not only in `run()`) so the
    // SAME merged set the run uses also reaches the transient probe that backs the
    // provider-config inspector (`withProbe` → `base`). Additive over the
    // user's native config (no `strictMcpConfig`); an empty/absent list leaves the
    // key unset, byte-identical to the pre-feature options.
    const mcpServers = toSdkMcpServers(this.cfg.mcpServers);
    return {
      cwd: this.cfg.cwd,
      executable: 'bun',
      stderr: (data) => this.logger?.debug('[sdk stderr]', data),
      // settingSources is kept config-driven, NOT dropped.
      // Nightcore's permission policy already governs every run regardless of this
      // value — the harness `PermissionLayer` (`canUseTool`) plus the SDK
      // `permissionMode` are what gate tool use; `settingSources` only loads
      // skills/commands/CLAUDE.md, not permission rules. Dropping `'user'` would
      // strip the user's own skills/commands (which the config contract wants to
      // "just work") without strengthening governance, so it stays config-driven.
      settingSources: this.cfg.settingSources,
      // No `agents` key: we deliberately do NOT register built-in subagent
      // presets on the main session. Registering them exposes the SDK `Agent`
      // (Task) tool to the main model, which then delegates shell work (e.g.
      // `bun run … build`/test) to a subagent instead of calling `Bash`
      // directly — surfacing as confusing `Agent`/`subagent_type` entries in the
      // logs and board transcript. Native tools only, matching the Claude-Code
      // mental model. The user's own filesystem-discovered agents (via
      // `settingSources`) are unaffected.
      // The task/todo feature has no run-`Options` key in the pinned SDK; it is
      // toggled via the `CLAUDE_CODE_ENABLE_TASKS` env var the bundled CLI reads.
      // `Options.env` REPLACES the subprocess environment wholesale. We do NOT
      // spread `...process.env` (that hands every unrelated secret in the desktop
      // app's env — AWS keys, GITHUB_TOKEN, DB creds — to an agent that under the
      // default bypass can exfiltrate them). Instead `buildSubprocessEnv` copies a
      // curated allowlist: system/runtime essentials (PATH/HOME/temp/locale/proxy/
      // TLS + Windows system vars) plus the agent's OWN `ANTHROPIC_*`/`CLAUDE_*`
      // credentials. When tasks are enabled we also turn on AI progress summaries
      // so `task_progress.summary` is populated for the live panel.
      env: buildSubprocessEnv(process.env, {
        CLAUDE_CODE_ENABLE_TASKS: this.cfg.todoFeatureEnabled ? '1' : '0',
      }),
      ...(this.cfg.todoFeatureEnabled ? { agentProgressSummaries: true } : {}),
      // Skills are filesystem-discovered via settingSources; only enable the
      // skills filter (which auto-adds the `Skill` tool) when at least one
      // source is loaded — with strict isolation there is nothing to enable.
      ...(hasSettingSources ? { skills: 'all' as const } : {}),
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      // Configured external MCP servers, additive over the user's native config.
      // Shared by the run and the inspector probe (both spread `base()`).
      ...(mcpServers !== undefined ? { mcpServers } : {}),
    };
  }

  /**
   * Full SDK options for the main `query()` — `base()` layered with the per-run
   * knobs (model, permission mode, autonomy ceilings, resume, checkpointing) plus
   * the live `runtime` collaborators the runner owns (`canUseTool` / `onUserDialog`
   * / `hooks` / the abort controller).
   */
  run(runtime: SessionRunOptionsRuntime): Options {
    return {
      ...this.base(),
      model: this.cfg.model,
      permissionMode: this.cfg.permissionMode,
      includePartialMessages: true,
      canUseTool: runtime.canUseTool,
      // AskUserQuestion is delivered as a `request_user_dialog` of this kind, NOT
      // via canUseTool. Declaring ONLY this dialog kind opts the session into
      // receiving it (the CLI fails closed on undeclared kinds) while leaving
      // every other dialog kind on its existing no-dialog/canUseTool behavior.
      onUserDialog: runtime.onUserDialog,
      supportedDialogKinds: runtime.supportedDialogKinds,
      // Native SDK tools only — the agent uses the SDK's native
      // Read/Write/Edit/Bash/Grep/Glob (the Claude-Code mental model); Nightcore
      // ships no in-house custom tools and registers no IN-PROCESS MCP server.
      // (User-configured EXTERNAL MCP servers are a separate thing: they ride
      // `Options.mcpServers`, folded in via `base()`.) The `ToolRegistry` is
      // kept solely for risk metadata via `riskOf`, which classifies the native
      // tools so the PermissionLayer auto-allows safe reads and still prompts on
      // writes/shell — and an unknown `mcp__*` tool from an external server is
      // already classified `dangerous`, so it always prompts (in non-bypass mode).
      hooks: runtime.hooks,
      abortController: runtime.abortController,
      ...(this.cfg.effort !== undefined ? { effort: this.cfg.effort } : {}),
      // The SDK ignores `permissionMode: 'bypassPermissions'` unless this safety
      // flag is explicitly set. This is config (not a secret) — fine to log
      // at debug. Bypass is the user's explicit choice for an autonomous studio.
      ...(this.cfg.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      // Compose the FINAL `appendSystemPrompt` as [working-root directive →
      // trusted context pack → kind-preset persona]: the authoritative run cwd
      // leads (worktree isolation — the prevent half of the confinement gate),
      // then project rules, then the reviewer/build persona. The pack is truncated
      // to a token budget so it can't crowd out the task. The directive is always
      // present, so `appendSystemPrompt` is effectively always set — even a `build`
      // session (no preset, no pack) now carries the working-root directive.
      ...((): { appendSystemPrompt?: string } => {
        const composed = composeAppendSystemPrompt(
          workingRootDirective(this.cfg.cwd),
          this.cfg.appendContextPack,
          this.cfg.appendSystemPrompt,
        );
        return composed !== undefined ? { appendSystemPrompt: composed } : {};
      })(),
      // Union the harness policy's `allowTools` (hardening module #9, allow
      // tier) into `allowedTools`. VERIFIED SDK semantics (sdk.d.ts,
      // @anthropic-ai/claude-agent-sdk@0.3.190, `Options.allowedTools`): "List
      // of tool names that are auto-allowed without prompting for permission.
      // … To restrict which tools are available, use the `tools` option
      // instead." — i.e. allowedTools is purely ADDITIVE auto-approval, not an
      // exclusive whitelist (the whitelist is the separate `tools` option), so
      // setting it for a session that previously passed nothing cannot
      // restrict anything. Entries are verbatim SDK permission-rule strings
      // (`WebSearch`, `Bash(git status:*)`). An allow never overrides a deny:
      // SDK deny rules and the PreToolUse gate still win.
      ...((): { allowedTools?: string[] } => {
        const preset = this.cfg.allowedTools;
        const policyAllowed = this.cfg.harnessPolicy?.allowTools ?? [];
        if (policyAllowed.length === 0) {
          return preset !== undefined ? { allowedTools: preset } : {};
        }
        return {
          allowedTools: [...new Set([...(preset ?? []), ...policyAllowed])],
        };
      })(),
      // Union the policy deny lists into `disallowedTools` so that a configured
      // `permissions.deny` entry — and the harness policy's least-privilege
      // `disallowedTools` (hardening module #9) — is hard-blocked even under
      // `bypassPermissions` mode (where `canUseTool` is never called by the
      // SDK). The SDK enforces `disallowedTools` regardless of permission mode —
      // this is the correct enforcement seam; the HookBus evaluator denies the
      // same tools at PreToolUse as defense in depth. Preset-provided entries
      // are preserved (union, not overwrite). Empty lists are a no-op: the
      // result collapses back to the preset value (or is omitted when all are
      // absent/empty).
      ...((): { disallowedTools?: string[] } => {
        const preset = this.cfg.disallowedTools ?? [];
        const denied = this.cfg.permissionPolicy.deny;
        const policyDenied = this.cfg.harnessPolicy?.disallowedTools ?? [];
        if (denied.length === 0 && policyDenied.length === 0) {
          return preset.length > 0 ? { disallowedTools: preset } : {};
        }
        const merged = [...new Set([...preset, ...denied, ...policyDenied])];
        return { disallowedTools: merged };
      })(),
      // Autonomy ceilings (maxTurns / maxBudgetUsd). An absent field leaves the
      // SDK default in place; a hit ceiling returns an
      // `error_max_turns` / `error_max_budget_usd` result the adapter maps to a
      // distinct `session-failed` reason (never a silent success).
      ...(this.cfg.maxTurns !== undefined ? { maxTurns: this.cfg.maxTurns } : {}),
      ...(this.cfg.maxBudgetUsd !== undefined
        ? { maxBudgetUsd: this.cfg.maxBudgetUsd }
        : {}),
      // Session resume: when a persisted SDK session id exists, reattach instead
      // of starting cold. The id is bookkeeping (not a secret),
      // but is only ever logged at debug — never at info/telemetry.
      ...(this.cfg.resumeSessionId !== undefined
        ? { resume: this.cfg.resumeSessionId }
        : {}),
      // File checkpointing: opt-in backend for `rewindFiles()`.
      ...(this.cfg.enableFileCheckpointing
        ? { enableFileCheckpointing: true }
        : {}),
      // SDK-native structured output (kind preset — `decompose`). The SDK forces
      // the model to return a schema-conforming object and retries non-conforming
      // output internally. Run-loop only (not `base()`): probes never take a model
      // turn. Absent ⇒ a free-form text result (pre-feature shape).
      ...(this.cfg.outputFormat !== undefined
        ? { outputFormat: this.cfg.outputFormat }
        : {}),
    };
  }
}
