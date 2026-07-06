/**
 * The read-only provider-configuration inspector reader.
 *
 * Builds a {@link ProviderConfigSnapshot} for a project from the SDK's runtime
 * control methods on a single transient probe (no model turn). The SDK returns its
 * RESOLVED, scope-aware config — authoritative over hand-parsing `.mcp.json` /
 * `~/.claude.json` — so the inspector shows exactly what a run would see.
 *
 * House rules (mirroring `SessionApi`):
 *  - The SDK is reached only through `sdk-adapter`/`SessionRunner` (the boundary).
 *  - Degrade-not-throw, PER SECTION: every control read is wrapped in its own
 *    try/catch so one failing call becomes THAT section's `unavailable`, never a
 *    failed snapshot. A genuinely empty result (e.g. strict-isolation skills) stays
 *    `supported` with an empty list — distinct from `unavailable`.
 *
 * The whole probe shares ONE subprocess via `SessionRunner.withProbe`, bounded by
 * the SDK abort controller; the caller's Rust `Provider::query` adds the 20s
 * timeout so a wedged probe can't hang the inspector.
 */
import type {
  McpServerSummary,
  ProviderConfigSection,
  ProviderConfigSnapshot,
  SkillSummary,
  SubagentSummary,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { getString } from '../../util/field-extract.js';
import type {
  AgentInfo,
  McpServerStatus,
  SDKControlInitializeResponse,
  SlashCommand,
} from './sdk-adapter.js';
import type { SessionRunner } from './session-runner.js';

/** Today's only provider. A second provider supplies its own id/label and may
 *  return `unsupported` sections — the inspector renders them with zero new
 *  branches. */
const CLAUDE_PROVIDER_ID = 'claude';
const CLAUDE_PROVIDER_LABEL = 'Claude';

/** Derive a coarse transport label from an SDK MCP server config. The config is a
 *  union (stdio / sse / http / sdk / claudeai-proxy); `type` is present on the
 *  url-based transports and absent (⇒ stdio) on the command-based one. Returns
 *  `undefined` when nothing is derivable, so the field is simply omitted. */
function mcpTransport(server: McpServerStatus): string | undefined {
  const type = getString(server.config, 'type');
  if (type !== undefined) return type;
  // A command-based stdio server omits `type`; infer it only when a config exists
  // that carries a `command` key.
  const config = server.config as Record<string, unknown> | undefined;
  if (config && 'command' in config) {
    return 'stdio';
  }
  return undefined;
}

/** Map one SDK `McpServerStatus` to the wire summary, surfacing status/scope
 *  verbatim (a mid-reconnect `pending`, a novel scope) rather than normalizing. */
function toMcpSummary(server: McpServerStatus): McpServerSummary {
  const transport = mcpTransport(server);
  return {
    name: server.name,
    status: server.status,
    ...(server.scope !== undefined ? { scope: server.scope } : {}),
    ...(transport !== undefined ? { transport } : {}),
    ...(server.tools !== undefined ? { toolCount: server.tools.length } : {}),
  };
}

/** Map one SDK slash command (skills surface as slash commands) to the wire
 *  summary. An empty description is omitted to match the `.optional()` wire shape. */
function toSkillSummary(command: SlashCommand): SkillSummary {
  return {
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
  };
}

/** Map one SDK `AgentInfo` to the wire subagent summary. */
function toSubagentSummary(agent: AgentInfo): SubagentSummary {
  return {
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
  };
}

/** Build a `supported` section from a successful read, or an `unavailable` section
 *  carrying the error when the read threw. Pure so each caller stays a one-liner. */
function sectionFrom<T extends Partial<ProviderConfigSection>>(
  read: () => Promise<T>,
  logger?: Logger,
  label?: string,
): Promise<ProviderConfigSection> {
  return read()
    .then(
      (payload): ProviderConfigSection => ({ status: 'supported', ...payload }),
    )
    .catch((error: unknown): ProviderConfigSection => {
      logger?.debug(`provider-config ${label ?? 'section'} read failed`, error);
      return {
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      };
    });
}

/** Reads the active provider's resolved configuration for a project. Stateless
 *  aside from an optional logger, so a caller can construct one per request. */
export class ProviderConfigReader {
  constructor(private readonly logger?: Logger) {}

  /**
   * Build the inspector snapshot for `projectPath`, probing the runner's SDK
   * control methods off ONE transient subprocess rooted at that path. Every
   * section degrades independently; the snapshot itself always resolves.
   */
  async read(
    runner: SessionRunner,
    projectPath: string,
  ): Promise<ProviderConfigSnapshot> {
    return runner.withProbe<ProviderConfigSnapshot>(
      async (probe) => {
        // Each control read is isolated: a single failure becomes that section's
        // `unavailable`, never a failed snapshot. They run concurrently against
        // the one shared probe subprocess.
        const [mcp, skills, subagents, extras] = await Promise.all([
          sectionFrom(
            async () => ({
              mcpServers: (await probe.mcpServerStatus()).map(toMcpSummary),
            }),
            this.logger,
            'mcp',
          ),
          sectionFrom(
            async () => ({
              skills: (await probe.supportedCommands()).map(toSkillSummary),
            }),
            this.logger,
            'skills',
          ),
          sectionFrom(
            async () => ({
              subagents: (await probe.supportedAgents()).map(toSubagentSummary),
            }),
            this.logger,
            'subagents',
          ),
          this.readExtras(() => probe.initializationResult()),
        ]);

        return {
          providerId: CLAUDE_PROVIDER_ID,
          providerLabel: CLAUDE_PROVIDER_LABEL,
          projectPath,
          mcp,
          skills,
          subagents,
          ...extras,
        };
      },
      this.unavailableSnapshot(projectPath),
      projectPath,
    );
  }

  /** Read the scalar extras (model / permission mode / output style) from the SDK
   *  init response, returning their values plus the group's tri-state. The init
   *  response carries `model`/`output_style` but not the permission mode, so that
   *  is left absent here. Degrades the WHOLE extras group to `unavailable` on a
   *  failed read (it is one cheap call, not three independent ones). */
  private async readExtras(
    read: () => Promise<SDKControlInitializeResponse>,
  ): Promise<Pick<
    ProviderConfigSnapshot,
    'model' | 'outputStyle' | 'extrasStatus'
  >> {
    try {
      const init = await read();
      const model = this.initModel(init);
      return {
        ...(model !== undefined ? { model } : {}),
        ...(init.output_style ? { outputStyle: init.output_style } : {}),
        extrasStatus: 'supported',
      };
    } catch (error) {
      this.logger?.debug('provider-config extras read failed', error);
      return { extrasStatus: 'unavailable' };
    }
  }

  /** The active model from an init response, if the SDK reported one. The init
   *  payload carries the resolved model list; the first entry's value is the
   *  active default. Returns `undefined` when the list is empty. */
  private initModel(init: SDKControlInitializeResponse): string | undefined {
    const first = init.models?.[0];
    return first?.value;
  }

  /** The snapshot returned when the probe subprocess itself can't be opened: every
   *  section `unavailable`, so the inspector renders soft errors + retry rather
   *  than a blank panel. Distinct from `unsupported` (a provider declining). */
  private unavailableSnapshot(projectPath: string): ProviderConfigSnapshot {
    const unavailable: ProviderConfigSection = {
      status: 'unavailable',
      error: 'provider probe could not be started',
    };
    return {
      providerId: CLAUDE_PROVIDER_ID,
      providerLabel: CLAUDE_PROVIDER_LABEL,
      projectPath,
      mcp: unavailable,
      skills: unavailable,
      subagents: unavailable,
      extrasStatus: 'unavailable',
    };
  }
}
