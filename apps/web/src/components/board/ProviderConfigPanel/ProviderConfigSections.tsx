/** The section-rendering primitives for the provider-config inspector: labeled
 *  tri-state section cards plus the row/pill/extras building blocks they compose. */
import type { ReactNode } from 'react';

import { RetryIcon } from '@/components/ui';
import type {
  McpServerSummary,
  ProviderConfigSection,
  ProviderConfigSnapshot,
} from '@/lib/bridge';

/** A monospace read-only value pill (matches the TaskDetail config-pill idiom). */
export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

/** A status chip whose tint reflects an MCP connection state. Unknown values fall
 *  back to neutral so a novel/mid-reconnect status still renders (surfaced
 *  verbatim, never normalized away). */
function McpStatusChip({ status }: { status: string }) {
  const tone =
    status === 'connected'
      ? 'text-success'
      : status === 'failed' || status === 'needs-auth'
        ? 'text-destructive'
        : 'text-muted-foreground';
  return (
    <span className={`font-mono text-[10.5px] font-semibold ${tone}`}>
      {status}
    </span>
  );
}

/** One labeled section that renders the per-section tri-state. This is the whole
 *  provider-abstraction payoff: `unsupported` → "Not available for this provider",
 *  `unavailable` → soft error + retry, `supported` → the section body (which may be
 *  an empty list). A second provider's declined sections render here with ZERO new
 *  branches. */
export function Section({
  icon,
  title,
  section,
  count,
  onRetry,
  emptyText,
  children,
}: {
  icon: ReactNode;
  title: string;
  section: ProviderConfigSection;
  count?: number;
  onRetry: () => void;
  emptyText: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[10px] border border-border bg-white/[0.02]">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-[12.5px] font-semibold">{title}</h3>
        {section.status === 'supported' && count !== undefined && (
          <span className="rounded-md border border-border bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      <div className="px-3.5 py-3">
        {section.status === 'unsupported' ? (
          <p className="text-[12px] text-muted-foreground">
            Not available for this provider
          </p>
        ) : section.status === 'unavailable' ? (
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-[12px] text-destructive">
              {section.error ?? "Couldn't read this section"}
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-white/[0.02] px-2.5 py-1 text-[11.5px] font-semibold text-foreground transition-colors hover:border-white/20"
            >
              <RetryIcon size={12} />
              Retry
            </button>
          </div>
        ) : count === 0 ? (
          <p className="text-[12px] text-muted-foreground">{emptyText}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/** One MCP server row: name + scope/transport meta + a status chip. */
export function McpRow({ server }: { server: McpServerSummary }) {
  return (
    <li className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[12px] text-foreground">
          {server.name}
        </span>
        {server.scope !== undefined && server.scope !== null && (
          <Pill>{server.scope}</Pill>
        )}
        {server.transport !== undefined && server.transport !== null && (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            {server.transport}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {server.toolCount !== undefined && server.toolCount !== null && (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            {server.toolCount} tools
          </span>
        )}
        <McpStatusChip status={server.status} />
      </div>
    </li>
  );
}

/** One skill/subagent row: name + an optional description. */
export function NamedRow({
  name,
  description,
  meta,
}: {
  name: string;
  description?: string | null;
  meta?: ReactNode;
}) {
  return (
    <li className="py-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-foreground">{name}</span>
        {meta}
      </div>
      {description !== undefined && description !== null && description !== '' && (
        <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
          {description}
        </p>
      )}
    </li>
  );
}

/** The scalar extras row (model / permission mode / output style), with its own
 *  tri-state. `permissionMode` is sourced from Nightcore's own settings resolver
 *  (not the SDK probe), so it renders independently of `extrasStatus`. */
export function Extras({ snapshot }: { snapshot: ProviderConfigSnapshot }) {
  // permissionMode is always present when Nightcore can resolve settings; render
  // it even when the probe-sourced extras (model/outputStyle) are unavailable.
  const permissionModeRow = (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-muted-foreground">Permission mode</span>
      {snapshot.permissionMode !== undefined &&
      snapshot.permissionMode !== null &&
      snapshot.permissionMode !== '' ? (
        <Pill>{snapshot.permissionMode}</Pill>
      ) : (
        <span className="font-mono text-[11px] text-muted-foreground/60">—</span>
      )}
    </div>
  );

  if (snapshot.extrasStatus === 'unsupported') {
    return (
      <div className="flex flex-col gap-2">
        {permissionModeRow}
        <p className="text-[12px] text-muted-foreground">
          Other defaults not available for this provider
        </p>
      </div>
    );
  }
  if (snapshot.extrasStatus === 'unavailable') {
    return (
      <div className="flex flex-col gap-2">
        {permissionModeRow}
        <p className="text-[12px] text-destructive">
          Couldn&apos;t read the provider defaults
        </p>
      </div>
    );
  }
  const entries: Array<[string, string | null | undefined]> = [
    ['Model', snapshot.model],
    ['Permission mode', snapshot.permissionMode],
    ['Output style', snapshot.outputStyle],
  ];
  return (
    <div className="flex flex-col gap-2">
      {entries.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted-foreground">{label}</span>
          {value !== undefined && value !== null && value !== '' ? (
            <Pill>{value}</Pill>
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground/60">—</span>
          )}
        </div>
      ))}
    </div>
  );
}
