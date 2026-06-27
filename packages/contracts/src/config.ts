import { z } from 'zod';

/**
 * Permission modes mirror the Claude Agent SDK's `PermissionMode` union exactly.
 * We re-declare it here (rather than importing the SDK) so that the contracts
 * package depends on nothing app-specific — surfaces and config can speak about
 * permission modes without pulling in the engine or the SDK.
 *
 * Keep in sync with `@anthropic-ai/claude-agent-sdk` `PermissionMode`.
 */
export const PermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * The kind of work a task represents (M4). `build` is the default and reproduces
 * today's behavior; `review` runs an independent read-only reviewer over a
 * worktree diff. `research`/`decompose` are reserved (defined, not yet produced).
 *
 * This enum is the single thing the Rust core and the engine share: the core owns
 * each kind's ORCHESTRATION policy (`kind.rs`), the engine owns its AGENT
 * DEFINITION (`kind-presets.ts`). Snake_case on the wire, matching the Rust
 * `TaskKind` serde mapping.
 */
export const TaskKindSchema = z.enum([
  'build',
  'research',
  'review',
  'decompose',
  'tdd',
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

/**
 * Known Claude model ids. `model` is a free string at the SDK boundary, but the
 * harness offers these as the curated default set. Exact non-Opus ids are
 * confirmed at build time against the models doc (see docs/architecture.md).
 */
export const KnownModelSchema = z.enum([
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
]);
export type KnownModel = z.infer<typeof KnownModelSchema>;

/**
 * Reasoning effort levels, mirroring the Claude Agent SDK's `EffortLevel`. Which
 * levels a given model actually supports is dynamic — query it at runtime via
 * the engine's `listModels()` (`ModelDescriptor.supportedEffortLevels`). This
 * enum is the full superset; the SDK silently downgrades unsupported levels.
 *
 * Keep in sync with `@anthropic-ai/claude-agent-sdk` `EffortLevel`.
 */
export const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/**
 * Which on-disk settings the SDK loads (`Options.settingSources`). Drives where
 * skills, slash commands, agents, and CLAUDE.md come from:
 *  - `user`    — `~/.claude` (global Claude Code env)
 *  - `project` — `./.claude` (per-project)
 *  - `local`   — project-local untracked settings
 * Default is all three, so a user's existing Claude Code skills/commands "just
 * work" in Nightcore. Set to `[]` for strict isolation.
 */
export const SettingSourceSchema = z.enum(['user', 'project', 'local']);
export type SettingSource = z.infer<typeof SettingSourceSchema>;

/**
 * Permission policy: how the harness should resolve tool-use requests before
 * falling back to interactive approval. Maps onto the SDK's allow/deny lists
 * plus the active permission mode.
 */
export const PermissionPolicySchema = z.object({
  /** Tools auto-allowed without prompting. */
  allow: z.array(z.string()).default([]),
  /** Tools always denied. */
  deny: z.array(z.string()).default([]),
  /** Default permission mode for new sessions. */
  mode: PermissionModeSchema.default('default'),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

/**
 * Resolved paths the harness reads/writes. Computed by `@nightcore/config` from
 * the home dir and the project root; surfaced here so any layer can reason about
 * them via the contract rather than recomputing.
 */
export const ConfigPathsSchema = z.object({
  /** `~/.nightcore` — global user state. */
  home: z.string(),
  /** Per-project `.nightcore` directory, when inside a project. */
  project: z.string().optional(),
  /** Where session metadata is persisted (under `home`). */
  sessions: z.string(),
});
export type ConfigPaths = z.infer<typeof ConfigPathsSchema>;

/**
 * The layered Nightcore configuration. Built by merging:
 * defaults → `~/.nightcore/config.json` → `./.nightcore/config.json`.
 */
export const LogLevelSchema = z.enum([
  'silent',
  'error',
  'warn',
  'info',
  'debug',
]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const ConfigSchema = z.object({
  /** Default model for new sessions. Free string to allow any SDK-supported id. */
  model: z.string().default('claude-opus-4-8'),
  /** Default reasoning effort for new sessions. Omitted = let the model decide
   *  (adaptive). The SDK downgrades silently if the model can't honor it. */
  effort: EffortLevelSchema.optional(),
  /** Permission policy applied to new sessions. */
  permissions: PermissionPolicySchema.prefault({}),
  /** On-disk settings sources the SDK loads (skills/commands/agents/CLAUDE.md).
   *  Defaults to all so existing Claude Code config works; `[]` = strict. */
  settingSources: z
    .array(SettingSourceSchema)
    .default(['user', 'project', 'local']),
  /** Enable the SDK's task/todo tracking (powers the live task panel). */
  todoFeatureEnabled: z.boolean().default(true),
  /** Autonomy ceiling: max conversation turns before a session stops (SDK
   *  `Options.maxTurns`). A finite guard so a wedged bypass-mode task can't burn
   *  turns forever. A per-task override wins; this is the studio-wide default. */
  maxTurns: z.number().int().positive().default(200),
  /** Autonomy ceiling: max spend in USD before a session stops (SDK
   *  `Options.maxBudgetUsd`). Omitted ⇒ uncapped (the SDK default). A per-task
   *  override wins; this is the studio-wide default. */
  maxBudgetUsd: z.number().positive().optional(),
  /** Resolved filesystem paths. */
  paths: ConfigPathsSchema,
  /** Log verbosity. */
  logLevel: LogLevelSchema.default('info'),
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * The user-authored portion of config (everything except resolved `paths`,
 * which the resolver computes). This is what lives in the on-disk JSON files.
 *
 * Critically, this schema carries **no defaults**: a field is present only if
 * the file set it explicitly. Defaults live solely on `ConfigSchema` (the
 * resolved shape). This is what lets `@nightcore/config` layer files correctly —
 * an absent key in a higher-precedence layer must *inherit*, not clobber with a
 * defaulted value. (`ConfigSchema.omit().partial()` would re-introduce field
 * defaults, which silently dropped inherited allow/deny lists.)
 */
export const ConfigFileSchema = z.object({
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  permissions: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      mode: PermissionModeSchema.optional(),
    })
    .optional(),
  settingSources: z.array(SettingSourceSchema).optional(),
  todoFeatureEnabled: z.boolean().optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  logLevel: LogLevelSchema.optional(),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/**
 * Transport-tagged config for one external MCP server the user wires via the UI.
 * Mirrors the Claude Agent SDK's `McpServerConfig` variants but tagged by
 * `transport` (NOT the SDK's optional stdio `type`) so the contract codegen emits a
 * clean, internally-tagged Rust enum and the tag can never collide with the SDK's
 * `type?: 'stdio'`. The engine translates `transport` → the SDK `type` when building
 * `Options.mcpServers` (omitting `type` for stdio, setting it for http/sse).
 *
 * `env`/`headers` use `z.record(z.string(), z.string())` (the codegen rejects
 * `z.unknown()`); values may carry secrets (tokens) — they are persisted in
 * plaintext in the Nightcore store, same trust model as the user's own
 * `~/.claude.json`, and never logged at info/telemetry.
 */
export const McpServerTransportSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    transport: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    transport: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
]);
export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;

/**
 * One user-configured external MCP server entry. `id` is a stable UI key (a uuid);
 * `name` is the SDK server key — it becomes the `mcpServers` record key and the
 * `mcp__<name>__*` tool prefix, so the UI must enforce a unique, safe charset.
 * `enabled` gates injection: only enabled entries reach `Options.mcpServers`.
 *
 * The charset regex rejects names that would produce malformed tool prefixes
 * (spaces, dots, slashes, etc.). Existing hand-written configs with exotic names
 * will fail this validation — rename the server in the config to a safe name.
 */
export const McpServerEntrySchema = z.object({
  id: z.string(),
  name: z
    .string()
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'MCP server name may only contain letters, digits, underscores, and hyphens',
    ),
  enabled: z.boolean().default(true),
  config: McpServerTransportSchema,
});
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

/**
 * A validated list of MCP server entries with uniqueness enforcement on `name`.
 * Use this schema at any boundary that accepts a list of servers (e.g. a config
 * file, a UI save handler) to catch duplicate names before they reach the SDK,
 * where `servers[entry.name]` would silently shadow an earlier entry.
 */
export const McpServerListSchema = z.array(McpServerEntrySchema).superRefine(
  (entries, ctx) => {
    const seen = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i]!.name;
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate MCP server name "${name}" at index ${i} (first seen at index ${seen.get(name)})`,
          path: [i, 'name'],
        });
      } else {
        seen.set(name, i);
      }
    }
  },
);
export type McpServerList = z.infer<typeof McpServerListSchema>;
