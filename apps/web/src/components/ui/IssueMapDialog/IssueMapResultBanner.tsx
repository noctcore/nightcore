/** The IssueMapDialog's terminal-result banner: the three NON-rejecting export
 *  outcomes the write command resolves with — full success, PARTIAL (a mid-run
 *  stop; nothing deleted), and DEGRADED linkage (native sub-issues unavailable →
 *  task-list fallback) — each surfacing the parent link. A best-effort
 *  supersede-close failure rides along as a subtle note. A HARD rejection (the
 *  parent never landed) is the shell's `exportError`, not this banner. */
import type { IssueMapResult } from '@/lib/bridge';

import { AlertIcon, CheckIcon, ExternalLinkIcon } from '../icons';

/** The parent-issue link every outcome surfaces (the map always lands first). */
function ParentLink({ result }: { result: IssueMapResult }) {
  return (
    <a
      href={result.parent.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-foreground underline decoration-dotted underline-offset-2 hover:text-primary"
    >
      #{result.parent.number} {result.parent.title}
      <ExternalLinkIcon size={12} className="shrink-0" />
    </a>
  );
}

export function IssueMapResultBanner({ result }: { result: IssueMapResult }) {
  // PARTIAL takes precedence: the run stopped mid-way and the user must know
  // exactly what landed and that nothing was destroyed.
  if (result.partial) {
    return (
      <div className="flex flex-col gap-2 rounded-[10px] border border-amber-500/40 bg-amber-500/[0.1] px-4 py-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-amber-200">
          <AlertIcon size={15} />
          Partial export — created {result.created} of {result.attempted} sub-issues
        </div>
        <p className="text-[12.5px] leading-snug text-amber-100/90">
          The export stopped
          {result.failedAt !== null ? ` at sub-issue #${result.failedAt + 1}` : ''}
          {result.error !== null ? `: ${result.error}` : '.'} Nothing was deleted — the map
          and the sub-issues that landed are on GitHub. Retrying mints a fresh map (use the
          supersede offer to close this one).
        </p>
        <ParentLink result={result} />
        {result.supersedeWarning !== null && (
          <p className="text-[11.5px] leading-snug text-amber-100/70">
            {result.supersedeWarning}
          </p>
        )}
      </div>
    );
  }

  // DEGRADED linkage: every sub-issue was created, but attached via a task-list
  // checklist rather than the native sub-issue relationship.
  if (result.degradedLinkage) {
    return (
      <div className="flex flex-col gap-2 rounded-[10px] border border-primary/40 bg-primary/[0.08] px-4 py-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
          <CheckIcon size={15} className="text-primary" />
          Exported {result.created} sub-issues (task-list linkage)
        </div>
        <p className="text-[12.5px] leading-snug text-muted-foreground">
          Native sub-issues weren&apos;t available for this repository, so the findings are
          linked from the parent via a task-list checklist instead of nested sub-issues. The
          map is complete.
        </p>
        <ParentLink result={result} />
        {result.supersedeWarning !== null && (
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            {result.supersedeWarning}
          </p>
        )}
      </div>
    );
  }

  // Full success.
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-emerald-500/40 bg-emerald-500/[0.1] px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald-200">
        <CheckIcon size={15} />
        Exported map with {result.created} sub-issues
      </div>
      <ParentLink result={result} />
      {result.supersedeWarning !== null && (
        <p className="text-[11.5px] leading-snug text-emerald-100/70">
          {result.supersedeWarning}
        </p>
      )}
    </div>
  );
}
