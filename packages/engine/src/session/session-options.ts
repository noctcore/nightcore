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
 * The pure compose helpers (`toSdkMcpServers`, `composeAppendSystemPrompt`,
 * `buildUserMessageContent`) stay exported so each translation is testable in
 * isolation.
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
import type { McpServerConfig, Options } from './sdk-adapter.js';
import { resolveClaudeBinary } from './resolve-claude-binary.js';
import { buildSubprocessEnv } from './subprocess-env.js';

/**
 * Translate the user-configured external MCP server entries (the `transport`-tagged
 * contract shape) into the SDK's `Options.mcpServers` map (`Record<name,
 * McpServerConfig>`). Pure, so it is unit-testable without spinning a query.
 *
 * Three translations matter:
 *  - filter to `enabled` entries (the Rust core already does this, but re-filtering
 *    here keeps the helper correct on any caller);
 *  - the entry `name` becomes the record KEY (the SDK keys on it, and it is the
 *    `mcp__<name>__*` tool prefix) — a later duplicate name wins (last write);
 *  - `transport` → the SDK's `type`: OMITTED for stdio (the SDK's `type?: 'stdio'`
 *    defaults to stdio), SET to `'http'`/`'sse'` for the remote transports.
 *
 * Returns `undefined` when no enabled entry survives, so the caller can omit the
 * `mcpServers` key entirely (byte-identical to the pre-feature options).
 */
export function toSdkMcpServers(
  entries: McpServerEntry[] | undefined,
): Record<string, McpServerConfig> | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const servers: Record<string, McpServerConfig> = {};
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const { config } = entry;
    if (config.transport === 'stdio') {
      // stdio: OMIT `type` (the SDK defaults it). Only set `env` when non-empty so
      // the options stay minimal.
      servers[entry.name] = {
        command: config.command,
        args: config.args,
        ...(Object.keys(config.env).length > 0 ? { env: config.env } : {}),
      };
    } else {
      // http / sse: SET `type` to the transport; only set `headers` when non-empty.
      servers[entry.name] = {
        type: config.transport,
        url: config.url,
        ...(Object.keys(config.headers).length > 0
          ? { headers: config.headers }
          : {}),
      };
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

/** Map a contract image `format` token to the SDK base64 source `media_type`. The
 *  contract uses bare tokens (codegen-clean Rust enum variants); the SDK wants the
 *  full MIME type. */
const WIRE_IMAGE_MEDIA_TYPE: Record<
  WireImage['format'],
  'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Build the SDK user-message content for a prompt + optional image attachments.
 *  Text-only stays a plain string (byte-identical to the pre-image shape); with
 *  attachments it becomes a content-block array — a text block followed by one
 *  base64 image block per attachment. `MessageParam.content` accepts both shapes.
 *  Exported for unit testing the block assembly. */
export function buildUserMessageContent(
  text: string,
  images: WireImage[] = [],
):
  | string
  | Array<
      | { type: 'text'; text: string }
      | {
          type: 'image';
          source: {
            type: 'base64';
            media_type: (typeof WIRE_IMAGE_MEDIA_TYPE)[WireImage['format']];
            data: string;
          };
        }
    > {
  if (images.length === 0) return text;
  return [
    { type: 'text' as const, text },
    ...images.map((image) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: WIRE_IMAGE_MEDIA_TYPE[image.format],
        data: image.data,
      },
    })),
  ];
}

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
}

/**
 * A conservative character budget for the injected context pack.
 * The pack leads the system prompt, so an unbounded pack could crowd out the task
 * and the model's own reasoning budget. ~12k characters is roughly 3k tokens — a
 * generous Constitution + arch summary + convention rules + memory excerpts, while
 * leaving the bulk of the window for the actual run. Truncation is hard-capped here
 * (not at the Rust source) so the engine is the last line of defence regardless of
 * what the core hands over.
 */
export const CONTEXT_PACK_MAX_CHARS = 12_000;

/** A visible marker appended when the pack is truncated, so a reader (human or
 *  model) knows the Constitution was clipped rather than silently ending. */
const CONTEXT_PACK_TRUNCATION_NOTICE =
  '\n\n…[context pack truncated to fit the pre-flight budget]';

/** Separator between the working-root directive, the context pack, and the
 *  kind-preset persona in the composed `appendSystemPrompt`. A blank line keeps
 *  the trusted blocks visually distinct in the assembled system prompt. */
const CONTEXT_PACK_SEPARATOR = '\n\n';

/**
 * The authoritative working-directory directive that LEADS every run's system
 * prompt. Nightcore worktrees live nested inside the main checkout
 * (`<repo>/.nightcore/worktrees/<taskId>`), so a model that sees the worktree cwd
 * can trivially resolve "up" to the main repo root and edit the wrong tree
 * (observed 2026-07-01). This states plainly that the run cwd IS the repository
 * for the task and out-of-cwd writes are blocked — the prevent half of the pair
 * whose enforce half is `evaluateWorkspaceConfinement` (the PreToolUse gate).
 */
export function workingRootDirective(cwd: string): string {
  return (
    `# Working directory (authoritative)\n\n` +
    `Your working directory for this task is:\n  ${cwd}\n\n` +
    `Treat THIS directory as the repository root for the task. Make every file ` +
    `read, write, and edit inside it, and prefer paths relative to it. Do NOT ` +
    `operate on any other copy of the repository — do not \`cd\` to a parent ` +
    `directory, and do not use an absolute path that points outside this ` +
    `directory. Writes outside this directory are blocked and will fail.`
  );
}

/**
 * Compose the final `appendSystemPrompt` from the working-root directive, the
 * (optional) trusted context pack, and the (optional) kind-preset persona — in
 * that order, so the authoritative working root leads, then project rules, then
 * the reviewer/build persona. The pack is truncated to [`CONTEXT_PACK_MAX_CHARS`]
 * so it can't crowd out the task. Returns `undefined` only when every part is
 * absent (the working-root directive is always present for a real run, so the
 * option is effectively always set). Pure + exported so the ordering is
 * unit-testable without spinning a query.
 */
export function composeAppendSystemPrompt(
  workingRoot: string | undefined,
  contextPack: string | undefined,
  persona: string | undefined,
): string | undefined {
  const pack = contextPack?.trim();
  const boundedPack =
    pack !== undefined && pack.length > 0
      ? pack.length > CONTEXT_PACK_MAX_CHARS
        ? pack.slice(0, CONTEXT_PACK_MAX_CHARS) + CONTEXT_PACK_TRUNCATION_NOTICE
        : pack
      : undefined;
  const parts = [workingRoot?.trim() || undefined, boundedPack, persona].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join(CONTEXT_PACK_SEPARATOR) : undefined;
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
    };
  }
}
