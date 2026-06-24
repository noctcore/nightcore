import { z } from 'zod';

/**
 * `provider-config` — the read-only provider-configuration inspector contract.
 *
 * A snapshot of how the active provider (today: Claude) is resolved for the
 * CURRENT project — its MCP servers, skills, subagents, and a tight set of scalar
 * extras (model / permission mode / output style). The engine reads this from the
 * SDK's runtime control methods on a transient probe (resolved + scope-aware), not
 * by hand-parsing `.mcp.json`/`~/.claude.json`.
 *
 * ## The per-section tri-state (the abstraction seam)
 *
 * Every section carries a `status`, NOT just a list, so a future provider (Codex)
 * slots in additively and degrades gracefully WITHOUT a `match provider` branch in
 * the inspector. The three states are DISTINCT — never collapse them:
 *
 *  - `supported`   — the provider reports this section; render its data (which may
 *                    legitimately be an EMPTY list, e.g. strict-isolation skills).
 *  - `unsupported` — the provider DECLARES it cannot report this section
 *                    (UI: "Not available for this provider").
 *  - `unavailable` — supported in principle, but the read failed this time
 *                    (UI: soft error + retry). `error` carries the short reason.
 *
 * Per-section independence is the whole point: one failing probe call becomes that
 * section's `unavailable`, never a failed snapshot.
 */

/** The tri-state every config section (and the scalar-extras group) carries. */
export const ConfigSectionStatusSchema = z.enum([
  'supported',
  'unsupported',
  'unavailable',
]);
export type ConfigSectionStatus = z.infer<typeof ConfigSectionStatusSchema>;

/** One MCP server as the SDK's `mcpServerStatus()` resolves it: the merged set
 *  WITH scope precedence and live connection status applied. `status`/`scope`/
 *  `transport` are surfaced as free strings (verbatim from the SDK) so a value the
 *  contract doesn't enumerate yet — a mid-reconnect `pending`, a new scope — is
 *  shown, not normalized away. */
export const McpServerSummarySchema = z.object({
  name: z.string(),
  /** Connection status at probe time: `connected`/`failed`/`needs-auth`/
   *  `pending`/`disabled` (surfaced verbatim). */
  status: z.string(),
  /** Resolution scope: `project`/`user`/`local`/`claudeai`/`managed`. */
  scope: z.string().optional(),
  /** Transport kind (`stdio`/`sse`/`http`), when derivable from the config. */
  transport: z.string().optional(),
  /** Tools the server exposes (only populated when connected). */
  toolCount: z.number().int().nonnegative().optional(),
});
export type McpServerSummary = z.infer<typeof McpServerSummarySchema>;

/** One skill discovered for the project (the SDK surfaces skills as slash
 *  commands). */
export const SkillSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

/** One subagent invokable via the Task tool, near-free on the same probe. */
export const SubagentSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Model alias the agent uses; absent ⇒ inherits the parent's model. */
  model: z.string().optional(),
});
export type SubagentSummary = z.infer<typeof SubagentSummarySchema>;

/** A single inspector section: its tri-state, an optional error (set only on
 *  `unavailable`), and exactly ONE of the typed payload lists (populated only on
 *  `supported`). The lists are independent slots — a section populates the one that
 *  matches its kind and leaves the rest absent. */
export const ProviderConfigSectionSchema = z.object({
  status: ConfigSectionStatusSchema,
  /** Short failure reason; present only when `status` is `unavailable`. */
  error: z.string().optional(),
  /** Populated for the MCP section when `supported`. */
  mcpServers: z.array(McpServerSummarySchema).optional(),
  /** Populated for the skills section when `supported`. */
  skills: z.array(SkillSummarySchema).optional(),
  /** Populated for the subagents section when `supported`. */
  subagents: z.array(SubagentSummarySchema).optional(),
});
export type ProviderConfigSection = z.infer<typeof ProviderConfigSectionSchema>;

/** The whole read-only snapshot for one project: provider identity, the project
 *  path it resolved against, the three per-section tri-states, and the scalar
 *  extras (with their own group tri-state). */
export const ProviderConfigSnapshotSchema = z.object({
  /** Provider id (today always `claude`). */
  providerId: z.string(),
  /** Human label for the provider (today `Claude`). */
  providerLabel: z.string(),
  /** The project root the snapshot resolved against (keys SDK config resolution). */
  projectPath: z.string(),
  mcp: ProviderConfigSectionSchema,
  skills: ProviderConfigSectionSchema,
  subagents: ProviderConfigSectionSchema,
  /** Active model for the project, when the extras read succeeded. */
  model: z.string().optional(),
  /** Active permission mode for the project, when the extras read succeeded. */
  permissionMode: z.string().optional(),
  /** Active output style, when the extras read succeeded. */
  outputStyle: z.string().optional(),
  /** Tri-state for the scalar extras group (model/permissionMode/outputStyle). */
  extrasStatus: ConfigSectionStatusSchema,
});
export type ProviderConfigSnapshot = z.infer<
  typeof ProviderConfigSnapshotSchema
>;
