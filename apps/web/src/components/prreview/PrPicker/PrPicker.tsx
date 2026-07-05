/** The PR Review list pane (left rail of the permanent two-panel workspace): the
 *  project's open PRs as selectable cards — each carrying its live run badges
 *  (reviewing spinner / open-finding count) — with a filter box that doubles as a
 *  manual-number entry for PRs not in the list (closed / old / beyond the cap). */
import {
  BranchIcon,
  Button,
  GithubIcon,
  RetryIcon,
  SearchIcon,
  Spinner,
  StatusDot,
  TagIcon,
} from '@/components/ui';

import { PrFilterBar } from '../PrFilterBar';
import { lifecycleToneClasses } from '../prreview-lifecycle';
import { usePrPicker } from './PrPicker.hooks';
import type { PrPickerProps } from './PrPicker.types';

export function PrPicker({
  prs,
  loading,
  error,
  value,
  onChange,
  onRefresh,
  disabled = false,
  statuses = {},
  findingCounts = {},
  hasMore = false,
  onLoadMore,
  loadingMore = false,
}: PrPickerProps) {
  const {
    query,
    setQuery,
    rows,
    manualNumber,
    hasQuery,
    authors,
    selectedAuthors,
    setSelectedAuthors,
    selectedStatuses,
    setSelectedStatuses,
    sort,
    setSort,
    hasActiveFilters,
    resetAll,
  } = usePrPicker(prs, value, statuses);
  const showEmpty = !loading && rows.length === 0 && manualNumber === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
      <div className="flex items-center justify-between px-1">
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Pull requests
          </span>
          <span className="rounded-full border border-border px-1.5 py-px text-[10.5px] text-muted-foreground">
            {prs.length}
          </span>
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={disabled || loading}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {loading ? <Spinner size={11} /> : <RetryIcon size={11} />}
          Refresh
        </button>
      </div>

      {/* Filter box — also the manual PR-number entry (BranchPicker pattern). */}
      <div
        className={`nc-focus-ring-host flex items-center gap-2 rounded-[10px] border bg-black/20 px-3 transition-colors focus-within:border-primary ${
          disabled ? 'border-border opacity-60' : 'border-border'
        }`}
      >
        <SearchIcon size={14} className="shrink-0 text-muted-foreground" />
        <input
          type="text"
          inputMode="text"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter PRs, or type a number…"
          aria-label="Filter open pull requests, or type a PR number"
          autoComplete="off"
          spellCheck={false}
          className="w-full bg-transparent py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed"
        />
      </div>

      {/* Filter bar: author + lifecycle-status multi-selects, sort, and the
          reset-all (which also clears the text box). Only meaningful once PRs
          have loaded. */}
      {prs.length > 0 && (
        <PrFilterBar
          authors={authors}
          selectedAuthors={selectedAuthors}
          onAuthorsChange={setSelectedAuthors}
          selectedStatuses={selectedStatuses}
          onStatusesChange={setSelectedStatuses}
          sort={sort}
          onSortChange={setSort}
          hasActiveFilters={hasActiveFilters}
          onReset={resetAll}
          disabled={disabled}
        />
      )}

      {error !== null && (
        <div
          role="alert"
          className="rounded-[10px] border border-destructive/50 bg-destructive/[0.06] px-3 py-2 text-[12.5px] text-destructive"
        >
          {error}
          <span className="block text-[11.5px] text-muted-foreground">
            You can still type a PR number above to review it.
          </span>
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="flex items-center gap-2 px-1 py-3 text-[12.5px] text-muted-foreground">
          <Spinner size={13} /> Loading pull requests…
        </div>
      )}

      {showEmpty && (
        <p className="px-1 py-2 text-[12.5px] text-muted-foreground">
          {hasQuery
            ? 'No open PR matches — type a full number above to review any PR.'
            : error === null
              ? 'No open pull requests. Type a number above to review any PR.'
              : null}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {rows.length > 0 && (
          <ul
            role="listbox"
            aria-label="Open pull requests"
            className="flex flex-col gap-2"
          >
            {rows.map(({ pr, selected }) => {
              const status = statuses[pr.number] ?? null;
              const tone = status !== null ? lifecycleToneClasses(status.tone) : null;
              const count = findingCounts[pr.number] ?? 0;
              return (
              <li key={pr.number} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  onClick={() => onChange(pr.number)}
                  className={`flex w-full flex-col gap-1.5 rounded-[12px] border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed ${
                    selected
                      ? 'border-primary/60 bg-primary/[0.08]'
                      : 'border-border bg-white/[0.02] hover:border-white/20'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="rounded-full border border-success/40 bg-success/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-success">
                      Open
                    </span>
                    <span className="font-mono text-[11.5px] text-muted-foreground">
                      #{pr.number}
                    </span>
                    {pr.isDraft && (
                      <span className="rounded-full border border-border px-1.5 py-px text-[9.5px] uppercase tracking-wide text-muted-foreground">
                        Draft
                      </span>
                    )}
                    {/* Review-position badges: a status dot + short label from
                        the per-PR lifecycle, plus the open-finding count. Plain
                        text (visible + sr-only suffix), never aria-label on a
                        generic span — the badge text is part of the option's
                        accessible name. not_reviewed shows only a bare row. */}
                    <span className="ml-auto inline-flex shrink-0 items-center gap-2">
                      {status !== null &&
                        status.state !== 'not_reviewed' &&
                        tone !== null && (
                          <span
                            className={`inline-flex items-center gap-1.5 text-[10.5px] font-medium ${tone.text}`}
                          >
                            <StatusDot colorClass={tone.dot} pulse={status.pulse} />
                            {status.shortLabel}
                          </span>
                        )}
                      {count > 0 && (
                        <span className="inline-flex items-center rounded-full border border-warning/40 bg-warning/[0.1] px-1.5 py-px font-mono text-[10px] font-semibold text-warning">
                          {count}
                          <span className="sr-only">
                            {count === 1 ? ' open finding' : ' open findings'}
                          </span>
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="truncate text-[13.5px] font-medium text-foreground">
                    {pr.title || '(no title)'}
                  </span>
                  <span className="flex items-center gap-3 text-[11.5px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <GithubIcon size={11} className="shrink-0" />@{pr.author}
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <BranchIcon size={11} className="shrink-0" />
                      <span className="truncate">{pr.headRefName}</span>
                    </span>
                    {pr.labels.length > 0 && (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <TagIcon size={11} />
                        {pr.labels.length}
                      </span>
                    )}
                    {/* Compact diff stats from the extended summary (additions in
                        the success tone, deletions destructive). Hidden only when
                        gh reported neither — a genuine 0/0 still reads as a size. */}
                    {(pr.additions > 0 || pr.deletions > 0) && (
                      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[10.5px]">
                        <span className="text-success">+{pr.additions}</span>
                        <span className="text-destructive">-{pr.deletions}</span>
                      </span>
                    )}
                  </span>
                </button>
              </li>
              );
            })}
          </ul>
        )}

        {manualNumber !== null && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(manualNumber)}
            className={`flex w-full items-center gap-2 rounded-[12px] border px-3.5 py-3 text-left text-[13px] transition-colors disabled:cursor-not-allowed ${
              value === manualNumber
                ? 'border-primary/60 bg-primary/[0.08] text-foreground'
                : 'border-dashed border-border text-muted-foreground hover:border-white/20 hover:text-foreground'
            }`}
          >
            <GithubIcon size={14} className="shrink-0 text-primary" />
            Select PR&nbsp;<span className="font-mono text-primary">
              #{manualNumber}
            </span>
            <span className="text-[11.5px] text-muted-foreground">— not in the list</span>
          </button>
        )}

        {/* Load-more footer: only once some PRs are loaded and no filter is
            narrowing the view (a filtered subset already hides rows, so "load
            more" there would confuse). Refetches at a doubled cap; the existing
            rows stay put while it runs. Mirrors the reference's footer row. */}
        {onLoadMore !== undefined && rows.length > 0 && !hasActiveFilters && (
          <div className="flex justify-center py-2">
            {hasMore ? (
              <Button variant="ghost" onClick={onLoadMore} disabled={disabled || loadingMore}>
                {loadingMore ? <Spinner size={13} /> : <RetryIcon size={13} />}
                {loadingMore ? 'Loading more…' : 'Load more'}
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground/60">All pull requests loaded</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
