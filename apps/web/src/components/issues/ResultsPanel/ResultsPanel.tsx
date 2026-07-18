/** The validation verdict panel: a headline verdict card (kind + verdict + confidence
 *  + staleness), the model's reasoning, grounded related files, estimated complexity,
 *  the proposed plan, missing info (needs-clarification), linked-PR analysis, and the
 *  two human-gated actions (Post as comment / Convert to task). Model prose
 *  (`reasoning`, `proposedPlan`, `prSummary`) is derived from untrusted GitHub input,
 *  so it renders through the sanitized `<Markdown>`. */
import type { ReactNode } from 'react';

import {
  AlertIcon,
  Button,
  CheckIcon,
  ExternalLinkIcon,
  GithubIcon,
  Markdown,
  MoveIcon,
} from '@/components/ui';

import {
  COMPLEXITY_META,
  CONFIDENCE_META,
  KIND_META,
  PR_RECOMMENDATION_META,
  VERDICT_META,
} from '../issue-triage.constants';
import type { IssueVerdictView } from '../issue-triage.types';
import type { ResultsPanelProps } from './ResultsPanel.types';

const SECTION_LABEL =
  'font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <span className={SECTION_LABEL}>{title}</span>
      {children}
    </section>
  );
}

/** The linked-PR analysis card (only when the validation reasoned about a PR). */
function PrAnalysisCard({ pr }: { pr: NonNullable<IssueVerdictView['prAnalysis']> }) {
  const rec = PR_RECOMMENDATION_META[pr.recommendation];
  return (
    <div className="flex flex-col gap-2 rounded-nc border border-primary/30 bg-primary/[0.05] px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <GithubIcon size={13} className="text-primary/90" />
        <span className="text-xs-plus font-semibold text-foreground">{rec.label}</span>
        {pr.prNumber !== null && (
          <span className="font-mono text-2xs text-muted-foreground">#{pr.prNumber}</span>
        )}
        {pr.prFixesIssue !== null && (
          <span className="font-mono text-3xs-plus text-muted-foreground">
            {pr.prFixesIssue ? 'fixes the issue' : 'does not fully fix it'}
          </span>
        )}
      </div>
      <p className="text-2xs-plus text-muted-foreground">{rec.hint}</p>
      {pr.prSummary !== null && pr.prSummary.trim().length > 0 && (
        <div className="border-t border-border/60 pt-2">
          <Markdown>{pr.prSummary}</Markdown>
        </div>
      )}
    </div>
  );
}

/** The verdict panel — assumes `stream.result` is present (parent gates on it). */
export function ResultsPanel({
  stream,
  stale,
  onPostComment,
  onConvertToTask,
  onGotoBoard,
}: ResultsPanelProps) {
  const result = stream.result;
  if (result === null) return null;

  const verdict = VERDICT_META[result.verdict];
  const posted = stream.postedAt !== null;
  const converted = stream.linkedTaskId !== null;

  return (
    <div className="flex flex-col gap-4">
      {/* Headline verdict card. */}
      <div className="flex flex-col gap-2.5 rounded-[12px] border border-border bg-white/[0.02] px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-2xs font-semibold ${verdict.chip} ${verdict.tone}`}
          >
            {verdict.label}
          </span>
          <span className="inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs-plus text-muted-foreground">
            {KIND_META[result.issueKind].label}
          </span>
          <span className="font-mono text-3xs-plus text-muted-foreground">
            {CONFIDENCE_META[result.confidence].label}
          </span>
          {stale && (
            <span
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/[0.12] px-1.5 py-0.5 font-mono text-3xs font-semibold uppercase tracking-wide text-warning"
              title="The issue changed on GitHub after this validation — re-validate for a current verdict."
            >
              <AlertIcon size={11} />
              Stale
            </span>
          )}
        </div>

        {result.issueKind === 'bug_report' && result.bugConfirmed !== null && (
          <div className="flex items-center gap-1.5 text-xs-flat">
            {result.bugConfirmed ? (
              <span className="inline-flex items-center gap-1 text-success">
                <CheckIcon size={13} /> Bug reproduced in the code
              </span>
            ) : (
              <span className="text-muted-foreground">Bug not reproduced in the code</span>
            )}
          </div>
        )}
      </div>

      <Section title="Reasoning">
        <Markdown>{result.reasoning}</Markdown>
      </Section>

      {result.prAnalysis !== null && (
        <Section title="Linked PR analysis">
          <PrAnalysisCard pr={result.prAnalysis} />
        </Section>
      )}

      {result.estimatedComplexity !== null && (
        <Section title="Estimated complexity">
          <span className="inline-flex w-fit items-center rounded-md border border-border bg-white/[0.03] px-2 py-0.5 text-xs-flat text-foreground">
            {COMPLEXITY_META[result.estimatedComplexity].label}
          </span>
        </Section>
      )}

      {result.proposedPlan !== null && result.proposedPlan.trim().length > 0 && (
        <Section title="Proposed plan">
          <div className="rounded-nc border border-border bg-white/[0.02] px-3.5 py-2.5">
            <Markdown>{result.proposedPlan}</Markdown>
          </div>
        </Section>
      )}

      {result.relatedFiles.length > 0 && (
        <Section title="Related files">
          <ul className="flex flex-col gap-1">
            {result.relatedFiles.map((file) => (
              <li key={file}>
                <code className="font-mono text-2xs-plus text-muted-foreground">{file}</code>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {result.missingInfo.length > 0 && (
        <Section title="Missing information">
          <ul className="flex list-disc flex-col gap-1 pl-4 text-xs-plus text-muted-foreground">
            {result.missingInfo.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </Section>
      )}

      {/* Human-gated actions. Posting is always behind the confirmed preview dialog. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3.5">
        {posted ? (
          <a
            href={stream.postedCommentUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-nc border border-success/40 bg-success/[0.08] px-3 py-1.5 text-xs-plus text-success"
          >
            <CheckIcon size={14} /> Comment posted
            <ExternalLinkIcon size={12} />
          </a>
        ) : (
          <Button onClick={onPostComment}>
            <GithubIcon size={15} />
            Post as comment
          </Button>
        )}

        {converted ? (
          <Button variant="secondary" onClick={onGotoBoard}>
            <MoveIcon size={15} />
            Go to task
          </Button>
        ) : (
          <Button variant="ghost" onClick={onConvertToTask}>
            <MoveIcon size={15} />
            Convert to task
          </Button>
        )}
      </div>
    </div>
  );
}
