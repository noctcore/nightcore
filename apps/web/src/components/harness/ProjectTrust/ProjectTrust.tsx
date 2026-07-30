/** The Project trust card: this repo's governance posture, not this task's.
 *
 *  A per-task Trust Report answers "would I trust THIS merge". A lead asks "would
 *  I trust this REPO" — verified merges, whether the deterministic gate actually
 *  passes, what the rails stopped, what it cost, and which governance decisions a
 *  human made along the way. Every number is computed on demand from the task
 *  store, the flight-recorder ledgers and the append-only governance journal, so
 *  nothing here can drift from the evidence it summarizes. The badge is the same
 *  value the export publishes. */
import { Badge, Button, EmptyState, LockIcon, Skeleton, Spinner } from '@/components/ui';

import { BadgePreview, JournalCounts, JournalLine, Stat } from './ProjectTrust.parts';
import type { ProjectTrustProps } from './ProjectTrust.types';
import { formatPassRate, formatUsd } from './ProjectTrust.utils';

export function ProjectTrust({
  summary,
  loading,
  exporting,
  onRefresh,
  onExportBadge,
}: ProjectTrustProps) {
  return (
    <section
      aria-label="Project trust"
      className="flex flex-col gap-3 rounded-nc border border-border bg-white/[0.015] p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-xs-plus3 font-semibold text-foreground">Project trust</h3>
          <p className="text-2xs-plus text-muted-foreground">
            This repo’s governance posture — verified merges, the deterministic gate’s record,
            what the rails stopped, and every governance decision a human made. Computed on
            demand, never cached.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={onExportBadge} disabled={summary === null || exporting}>
            {exporting && <Spinner size={12} />}
            Export badge
          </Button>
          <Button variant="ghost" onClick={onRefresh} disabled={loading}>
            {loading && <Spinner size={12} />}
            Refresh
          </Button>
        </div>
      </div>

      {summary === null ? (
        <div role="status" aria-busy className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <>
          <BadgePreview badge={summary.badge} />

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Verified merges"
              value={String(summary.merges.verifiedMerges)}
              detail={`of ${summary.merges.merged} merged · ${summary.merges.tasks} tasks`}
            />
            <Stat
              label="Gauntlet"
              value={formatPassRate(summary.gauntlet.passRate)}
              detail={
                summary.gauntlet.runs === 0
                  ? 'never run'
                  : `${summary.gauntlet.passed} of ${summary.gauntlet.runs} runs passed`
              }
            />
            <Stat
              label="Denials"
              value={String(summary.guardrails.denied)}
              detail={`${summary.guardrails.policyDenials} from your policy · ${summary.guardrails.toolsEvaluated} calls gated`}
            />
            <Stat
              label="Spend"
              value={formatUsd(summary.spend.costUsd)}
              detail={`${summary.spend.tasksWithCost} tasks · last run each`}
            />
          </div>

          {summary.guardrails.topRules.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-3xs uppercase tracking-wide text-muted-foreground/80">
                Top rules
              </span>
              {summary.guardrails.topRules.map((rule) => (
                <Badge key={rule.ruleId} tone={rule.source === 'policy' ? 'primary' : 'neutral'}>
                  {rule.ruleId} · {rule.count}
                </Badge>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-2xs-plus font-semibold text-foreground">Governance journal</h4>
              <JournalCounts journal={summary.journal} />
            </div>

            {summary.journal.corruptLines > 0 && (
              <p className="rounded-md border border-warning/40 bg-warning/[0.08] px-3 py-2 text-2xs-plus text-warning">
                {summary.journal.corruptLines} unreadable line(s) in the journal were skipped. The
                records around them are intact — the counts above exclude only what could not be
                parsed.
              </p>
            )}

            {summary.journal.recent.length === 0 ? (
              <EmptyState
                className="min-h-[120px]"
                icon={<LockIcon size={18} />}
                title="No governance decisions recorded"
                description="Nothing has been quarantined, armed, disarmed, ratcheted or policy-saved for this project yet. The journal starts the first time you change a rail."
              />
            ) : (
              <ul className="flex flex-col">
                {summary.journal.recent.map((event) => (
                  <JournalLine key={event.id} event={event} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
