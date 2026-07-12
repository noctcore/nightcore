/** The selected issue's detail: header (number, title, labels, author, age,
 *  comment count, linked-PR badges), the issue body, and the first page of comments.
 *  The body and every comment body are UNTRUSTED GitHub markdown — rendered through
 *  the DOMPurify-sanitized `<Markdown>` and clearly framed as untrusted content. */
import {
  AlertIcon,
  EmptyState,
  GithubIcon,
  Markdown,
  Skeleton,
} from '@/components/ui';
import { formatRelativeTime } from '@/lib/formatters';

import type { IssueDetailPanelProps } from './IssueDetailPanel.types';

const UNTRUSTED_LABEL = 'untrusted GitHub content · sanitized';

const SECTION_LABEL =
  'font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground';

/** The issue detail reader. */
export function IssueDetailPanel({ issue, detail, loading, error }: IssueDetailPanelProps) {
  if (issue === null) {
    return (
      <EmptyState
        icon={<GithubIcon size={28} />}
        title="Select an issue"
        description="Pick an issue from the list to read it and validate it against the codebase."
      />
    );
  }

  const age = formatRelativeTime(issue.updatedAt);

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs-flat text-muted-foreground">#{issue.number}</span>
          <h2 className="text-[15px] font-semibold leading-snug text-foreground">
            {issue.title}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-3xs-plus text-muted-foreground">
          <span className="rounded-md border border-success/40 bg-success/[0.1] px-1.5 py-0.5 uppercase tracking-wide text-success">
            {issue.state}
          </span>
          <span>{issue.author}</span>
          {age !== '' && (
            <>
              <span aria-hidden>·</span>
              <span>updated {age} ago</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span>
            {issue.commentCount} {issue.commentCount === 1 ? 'comment' : 'comments'}
          </span>
        </div>

        {issue.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {issue.labels.map((label) => (
              <span
                key={label}
                className="rounded-md border border-border bg-white/[0.03] px-1.5 py-px font-mono text-4xs-plus text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {issue.linkedPrs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {issue.linkedPrs.map((pr) => (
              <span
                key={pr.number}
                className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/[0.08] px-1.5 py-0.5 font-mono text-3xs text-primary/90"
                title={pr.title}
              >
                <GithubIcon size={11} />#{pr.number} · {pr.state}
              </span>
            ))}
          </div>
        )}
      </header>

      <section className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-2">
          <span className={SECTION_LABEL}>Description</span>
          <span className="text-3xs text-muted-foreground/70">{UNTRUSTED_LABEL}</span>
        </div>
        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>
        ) : error !== null ? (
          <div className="flex items-center gap-2 rounded-[10px] border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-xs-plus text-destructive">
            <AlertIcon size={14} />
            {error}
          </div>
        ) : detail !== null && detail.body.trim().length > 0 ? (
          <div className="rounded-[10px] border border-border bg-white/[0.02] px-3.5 py-2.5">
            <Markdown>{detail.body}</Markdown>
          </div>
        ) : (
          <p className="text-xs-plus2 text-muted-foreground">No description provided.</p>
        )}
      </section>

      {detail !== null && detail.comments.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className={SECTION_LABEL}>
              {detail.comments.length} {detail.comments.length === 1 ? 'comment' : 'comments'}
            </span>
            <span className="text-3xs text-muted-foreground/70">{UNTRUSTED_LABEL}</span>
          </div>
          <ul className="flex flex-col gap-2.5">
            {detail.comments.map((comment) => (
              <li
                key={comment.id}
                className="rounded-[10px] border border-border bg-white/[0.02] px-3.5 py-2.5"
              >
                <div className="mb-1.5 flex items-center gap-2 font-mono text-3xs-plus text-muted-foreground">
                  <span className="text-foreground/80">{comment.author}</span>
                  {formatRelativeTime(comment.createdAt) !== '' && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{formatRelativeTime(comment.createdAt)} ago</span>
                    </>
                  )}
                </div>
                <Markdown>{comment.body}</Markdown>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
