/** The Trust band's native sections — gauntlet & review, guardrails, and the
 *  flight summary — rendered from the structured report (no markdown). Every
 *  untrusted span (paths, command digests) is a plain React text node, so React
 *  escapes it; the GitHub-safe fencing only matters on the markdown export path. */
import { STEP_STATUS_GLYPH, STEP_STATUS_TEXT } from '../GauntletResults';
import { formatCount, formatUsd } from './TrustReport.hooks';
import type { TrustReportData, TrustSectionProps } from './TrustReport.types';

/** A mono section heading matching the drawer idiom. */
function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
      {children}
    </h3>
  );
}

/** A quiet inline code span for an untrusted path / command digest. */
function Code({ children }: { children: string }) {
  return (
    <span className="truncate rounded bg-muted/50 px-1 font-mono text-[11px] text-foreground/90">
      {children}
    </span>
  );
}

/** The gauntlet + reviewer section, read verbatim off the task (never re-run). */
function GauntletSection({ report }: TrustSectionProps) {
  const g = report.gauntlet;
  const lock = g.structureLock ?? null;
  const hasSignal = g.verified || g.verdict != null || lock != null || g.fixAttempts > 0;
  return (
    <section>
      <SectionHeading>Gauntlet &amp; review</SectionHeading>
      {!hasSignal ? (
        <p className="text-sm text-muted-foreground">
          Not yet verified — no gauntlet or reviewer result recorded.
        </p>
      ) : (
        <ul className="space-y-1 text-xs">
          <li className="flex items-center gap-2">
            <span className="text-foreground">Verified</span>
            <span className={g.verified ? 'text-success' : 'text-destructive'}>
              {g.verified ? '✓ yes' : '× no'}
            </span>
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 text-foreground">Verdict</span>
            <span className="text-muted-foreground">{g.verdict ?? 'none recorded'}</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="text-foreground">Auto-fix rounds</span>
            <span className="text-muted-foreground">{g.fixAttempts}</span>
          </li>
          {lock != null && (
            <li>
              <div className="flex items-center gap-2">
                <span className="text-foreground">Structure-lock</span>
                <span className={lock.passed ? 'text-success' : 'text-destructive'}>
                  {lock.passed
                    ? '✓ passed'
                    : `× failed${lock.failedCheck != null ? ` at ${lock.failedCheck}` : ''}`}
                </span>
              </div>
              {lock.checks.length > 0 && (
                <ul className="mt-1 space-y-1 pl-4 font-mono">
                  {lock.checks.map((c) => (
                    <li key={c.name} className="flex items-center gap-2">
                      <span className={`w-3 text-center ${STEP_STATUS_TEXT[c.status]}`}>
                        {STEP_STATUS_GLYPH[c.status]}
                      </span>
                      <span className="text-foreground">{c.name}</span>
                      <Code>{c.command}</Code>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** One guardrail-event tier (denied / asked), rendered as an indented list. */
function EventList({
  label,
  events,
}: {
  label: string;
  events: TrustReportData['guardrails']['blocked'];
}) {
  if (events.length === 0) return null;
  return (
    <li>
      <span className="text-foreground">{label}</span>
      <ul className="mt-1 space-y-1 pl-4">
        {events.map((e, i) => (
          <li key={`${e.tool}-${e.ts ?? i}`} className="flex flex-wrap items-center gap-x-2">
            <span className="font-mono text-[11px] text-foreground">{e.tool}</span>
            {e.ruleId != null && (
              <span className="text-muted-foreground">rule {e.ruleId}</span>
            )}
            {e.digest != null && <Code>{e.digest}</Code>}
            {e.ts != null && <span className="text-muted-foreground">{e.ts}</span>}
          </li>
        ))}
      </ul>
    </li>
  );
}

/** The guardrail section: durable deny/ask/allow tiers + policy holds. */
function GuardrailSection({ report }: TrustSectionProps) {
  const g = report.guardrails;
  return (
    <section>
      <SectionHeading>Guardrails</SectionHeading>
      {g.toolsEvaluated === 0 ? (
        <p className="text-sm text-muted-foreground">No tool calls evaluated yet.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          <li className="text-muted-foreground">
            <span className="text-foreground">{g.toolsEvaluated}</span> tool call
            {g.toolsEvaluated === 1 ? '' : 's'} evaluated — allowed {g.allowed} · asked {g.asked} ·
            denied {g.denied}
          </li>
          {g.policyHold != null && (
            <li className="text-destructive">Policy hold: {g.policyHold}</li>
          )}
          {g.scopePark != null && (
            <li className="text-destructive">
              Scope park (transient — only while parked): {g.scopePark}
            </li>
          )}
          <EventList label="Denied actions" events={g.blocked} />
          <EventList label="Asked actions" events={g.askedEvents} />
        </ul>
      )}
    </section>
  );
}

/** A capped digest list (files touched / commands run) with an "…and N more" tail. */
function CappedList({ items, total }: { items: string[]; total: number }) {
  const hidden = total - items.length;
  if (items.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1 pl-4">
      {items.map((item, i) => (
        <li key={`${i}-${item}`} className="flex">
          <Code>{item}</Code>
        </li>
      ))}
      {hidden > 0 && <li className="text-muted-foreground">…and {hidden} more</li>}
    </ul>
  );
}

/** The flight-recorder summary: sessions, touched files, commands, cost/tokens. */
function FlightSection({ report }: TrustSectionProps) {
  const f = report.flight;
  const empty = f.sessionCount === 0 && f.filesTouchedCount === 0 && f.commandsCount === 0;
  return (
    <section>
      <SectionHeading>Flight summary</SectionHeading>
      {empty ? (
        <p className="text-sm text-muted-foreground">No sessions recorded yet.</p>
      ) : (
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>
            <span className="text-foreground">Sessions</span> {f.sessionCount}
          </li>
          <li>
            <span className="text-foreground">Files touched</span> {f.filesTouchedCount}
            <CappedList items={f.filesTouched} total={f.filesTouchedCount} />
          </li>
          <li>
            <span className="text-foreground">Commands run</span> {f.commandsCount}
            <CappedList items={f.commands} total={f.commandsCount} />
          </li>
          <li>
            <span className="text-foreground">Cost</span>{' '}
            {f.costUsdLastRun != null ? `last run ${formatUsd(f.costUsdLastRun)}` : 'last run n/a'}
            {f.costUsdTotal != null &&
              ` · ≈ ${formatUsd(f.costUsdTotal)} total (excludes fix-session spend)`}
          </li>
          {f.tokens != null && (
            <li>
              <span className="text-foreground">Tokens</span> in {formatCount(f.tokens.input)} · out{' '}
              {formatCount(f.tokens.output)} · reasoning {formatCount(f.tokens.reasoningOutput)} ·
              cache {formatCount(f.tokens.cacheRead)}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** All three native sections of the Trust receipt, stacked. */
export function TrustSections({ report }: TrustSectionProps) {
  return (
    <div className="space-y-3">
      <GauntletSection report={report} />
      <GuardrailSection report={report} />
      <FlightSection report={report} />
    </div>
  );
}
