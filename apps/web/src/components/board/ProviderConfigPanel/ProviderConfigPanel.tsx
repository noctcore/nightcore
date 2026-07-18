/** Read-only inspector sheet for the default provider's resolved configuration. */
import {
  AgentsIcon,
  Badge,
  BoltIcon,
  CloseIcon,
  IconButton,
  LayersIcon,
  Modal,
  RetryIcon,
  slideIn,
  SparkIcon,
  TerminalIcon,
} from '@/components/ui';
import type { SkillSummary, SubagentSummary } from '@/lib/bridge';

import {
  LIVE_PROVIDER_CONFIG_DATA,
  useProviderConfig,
} from './ProviderConfigPanel.hooks';
import type { ProviderConfigPanelProps } from './ProviderConfigPanel.types';
import {
  Extras,
  McpRow,
  NamedRow,
  Pill,
  Section,
} from './ProviderConfigSections';
import { ProviderConfigSkeleton } from './ProviderConfigSkeleton';

/**
 * The read-only provider-configuration inspector: a right-side sheet showing how
 * the default provider is RESOLVED for the current project — its MCP
 * servers, skills, subagents, and scalar extras. Every section renders its own
 * tri-state, so a future provider that can't report a section degrades gracefully
 * with no new UI branches.
 */
export function ProviderConfigPanel({
  open,
  projectPath,
  projectName,
  onClose,
  data = LIVE_PROVIDER_CONFIG_DATA,
}: ProviderConfigPanelProps) {
  const { snapshot, loading, error, reload } = useProviderConfig(
    open,
    projectPath,
    data,
  );

  return (
    <Modal
      open={open}
      label="Provider configuration"
      onClose={onClose}
      overlayClassName="fixed inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-sm"
      variant="sheet"
      panelClassName="max-w-md"
      panelVariants={slideIn}
    >
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary">
          <BoltIcon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">
              {snapshot?.providerLabel ?? 'Provider'} configuration
            </h2>
            <Badge>read-only</Badge>
          </div>
          <p className="truncate font-mono text-2xs text-muted-foreground">
            {projectName}
          </p>
        </div>
        <IconButton label="Close inspector" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
        {loading ? (
          <div
            role="status"
            aria-busy="true"
            aria-label="Reading provider configuration"
            className="flex flex-col gap-3"
          >
            <span className="sr-only">Reading provider configuration…</span>
            <ProviderConfigSkeleton />
          </div>
        ) : error !== null || snapshot === null ? (
          <div className="flex flex-col items-start gap-2.5 rounded-nc border border-destructive/40 bg-destructive/[0.1] p-3.5">
            <p className="text-xs-plus2 text-foreground">
              {error ?? "Couldn't read the provider configuration."}
            </p>
            <button
              type="button"
              onClick={reload}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs-flat font-semibold text-primary-foreground transition-[filter] hover:brightness-110"
            >
              <RetryIcon size={13} />
              Retry
            </button>
          </div>
        ) : (
          <>
            <Section
              icon={<LayersIcon size={14} />}
              title="MCP servers"
              section={snapshot.mcp}
              count={snapshot.mcp.mcpServers?.length}
              onRetry={reload}
              emptyText="No MCP servers configured for this project."
            >
              <ul className="divide-y divide-border">
                {snapshot.mcp.mcpServers?.map((server) => (
                  <McpRow key={server.name} server={server} />
                ))}
              </ul>
            </Section>

            <Section
              icon={<SparkIcon size={14} />}
              title="Skills"
              section={snapshot.skills}
              count={snapshot.skills.skills?.length}
              onRetry={reload}
              emptyText="No skills discovered for this project."
            >
              <ul className="divide-y divide-border">
                {snapshot.skills.skills?.map((skill: SkillSummary) => (
                  <NamedRow
                    key={skill.name}
                    name={skill.name}
                    description={skill.description}
                  />
                ))}
              </ul>
            </Section>

            <Section
              icon={<AgentsIcon size={14} />}
              title="Subagents"
              section={snapshot.subagents}
              count={snapshot.subagents.subagents?.length}
              onRetry={reload}
              emptyText="No subagents available for this project."
            >
              <ul className="divide-y divide-border">
                {snapshot.subagents.subagents?.map((agent: SubagentSummary) => (
                  <NamedRow
                    key={agent.name}
                    name={agent.name}
                    description={agent.description}
                    meta={
                      agent.model !== undefined && agent.model !== null ? (
                        <Pill>{agent.model}</Pill>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
            </Section>

            <section className="rounded-nc border border-border bg-white/[0.02]">
              <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
                <span className="text-muted-foreground">
                  <TerminalIcon size={14} />
                </span>
                <h3 className="text-xs-plus font-semibold">Defaults</h3>
              </div>
              <div className="px-3.5 py-3">
                <Extras snapshot={snapshot} />
              </div>
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
