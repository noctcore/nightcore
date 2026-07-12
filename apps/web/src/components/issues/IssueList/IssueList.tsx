/** The left-pane list of a project's open GitHub issues: a client-side filter, a
 *  scrollable list of issue rows (number, title, labels, author, age, comment count,
 *  linked-PR + validation badges), and the house-style loading / error / empty
 *  states. Issue titles/labels/authors are untrusted GitHub text — rendered as plain
 *  (React-escaped) text here; the long-form body + comments render through the
 *  sanitized `<Markdown>` in the detail panel. */
import {
  AlertIcon,
  CheckIcon,
  EmptyState,
  GithubIcon,
  RefreshIcon,
  SearchIcon,
  Skeleton,
} from '@/components/ui';
import type { IssueSummary } from '@/lib/bridge';
import { formatRelativeTime } from '@/lib/formatters';

import type { IssueListProps, IssueValidationBadge } from './IssueList.types';

/** A validation badge for a row: green check when validated, amber dot when stale. */
function ValidationChip({ badge }: { badge: IssueValidationBadge }) {
  if (badge === 'stale') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/[0.12] px-1.5 py-0.5 font-mono text-4xs font-semibold uppercase tracking-wide text-warning"
        title="The issue changed on GitHub since it was last validated"
      >
        <AlertIcon size={10} />
        Stale
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-success/40 bg-success/[0.12] px-1.5 py-0.5 font-mono text-4xs font-semibold uppercase tracking-wide text-success"
      title="Validated"
    >
      <CheckIcon size={10} />
      Validated
    </span>
  );
}

/** One issue row in the list. */
function IssueRow({
  issue,
  selected,
  badge,
  onSelect,
}: {
  issue: IssueSummary;
  selected: boolean;
  badge: IssueValidationBadge | undefined;
  onSelect: (issue: IssueSummary) => void;
}) {
  const age = formatRelativeTime(issue.updatedAt);
  return (
    <button
      type="button"
      onClick={() => onSelect(issue)}
      aria-current={selected ? 'true' : undefined}
      className={`flex w-full flex-col gap-1.5 border-b border-border/60 px-4 py-3 text-left transition-colors ${
        selected
          ? 'bg-primary/[0.1]'
          : 'hover:bg-white/[0.03]'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-2xs text-muted-foreground">#{issue.number}</span>
        <span className="min-w-0 flex-1 truncate text-xs-plus2 font-medium text-foreground">
          {issue.title}
        </span>
        {badge !== undefined && <ValidationChip badge={badge} />}
      </div>

      {issue.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {issue.labels.slice(0, 4).map((label) => (
            <span
              key={label}
              className="rounded-md border border-border bg-white/[0.03] px-1.5 py-px font-mono text-4xs-plus text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {issue.labels.length > 4 && (
            <span className="font-mono text-4xs-plus text-muted-foreground/70">
              +{issue.labels.length - 4}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 font-mono text-3xs-plus text-muted-foreground/80">
        <span className="truncate">{issue.author}</span>
        {age !== '' && (
          <>
            <span aria-hidden>·</span>
            <span>{age}</span>
          </>
        )}
        <span aria-hidden>·</span>
        <span>
          {issue.commentCount} {issue.commentCount === 1 ? 'comment' : 'comments'}
        </span>
        {issue.linkedPrs.length > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-primary/80">
            <GithubIcon size={11} />
            {issue.linkedPrs.length} PR{issue.linkedPrs.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </button>
  );
}

/** The issue list with its filter bar + house-style states. */
export function IssueList({
  issues,
  totalCount,
  loading,
  error,
  filter,
  onFilterChange,
  selectedNumber,
  onSelect,
  onRetry,
  badgeByNumber,
}: IssueListProps) {
  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="relative flex-1">
          <SearchIcon
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            aria-label="Filter issues by label or text"
            placeholder="Filter issues…"
            className="w-full rounded-[9px] border border-border bg-white/[0.02] py-1.5 pl-8 pr-2.5 text-xs-plus text-foreground placeholder:text-muted-foreground/70 focus:border-primary/60 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={onRetry}
          aria-label="Refresh issues"
          title="Refresh issues"
          className="rounded-[9px] border border-border bg-white/[0.02] p-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <RefreshIcon size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-[10px]" />
            ))}
          </div>
        ) : error !== null ? (
          <EmptyState
            icon={<AlertIcon size={28} />}
            title="Couldn't load issues"
            description={error}
            action={
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded-[9px] border border-border bg-white/[0.03] px-3 py-1.5 text-xs-plus text-foreground transition-colors hover:bg-white/[0.06]"
              >
                <RefreshIcon size={13} />
                Retry
              </button>
            }
          />
        ) : issues.length === 0 ? (
          <EmptyState
            icon={<GithubIcon size={28} />}
            title={totalCount === 0 ? 'No open issues' : 'No matching issues'}
            description={
              totalCount === 0
                ? 'This project has no open GitHub issues to triage.'
                : 'No open issues match your filter. Clear it to see them all.'
            }
          />
        ) : (
          <ul>
            {issues.map((issue) => (
              <li key={issue.number}>
                <IssueRow
                  issue={issue}
                  selected={issue.number === selectedNumber}
                  badge={badgeByNumber[issue.number]}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
