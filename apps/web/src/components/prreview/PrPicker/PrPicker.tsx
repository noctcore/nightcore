/** The PR Review pull-request picker: a filterable list of the project's open PRs
 *  so the user SELECTS one instead of memorizing a number. The filter box doubles
 *  as a manual-number entry for PRs not in the list (closed / old / beyond the cap). */
import {
  BranchIcon,
  CheckIcon,
  GithubIcon,
  RetryIcon,
  SearchIcon,
  Spinner,
} from '@/components/ui';

import { usePrPicker } from './PrPicker.hooks';
import type { PrPickerProps } from './PrPicker.types';

/** gh timestamps are ISO-8601; show a short local date, or nothing if unparseable. */
function shortDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function PrPicker({
  prs,
  loading,
  error,
  value,
  onChange,
  onRefresh,
  disabled = false,
}: PrPickerProps) {
  const { query, setQuery, rows, manualNumber, hasQuery } = usePrPicker(prs, value);
  const showEmpty = !loading && rows.length === 0 && manualNumber === null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          Pull request
        </span>
        <div className="flex items-center gap-3">
          {value !== null && (
            <span className="font-mono text-[11px] text-primary">
              #{value} selected
            </span>
          )}
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
          placeholder="Filter open PRs, or type a number…"
          aria-label="Filter open pull requests, or type a PR number"
          autoComplete="off"
          spellCheck={false}
          className="w-full bg-transparent py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed"
        />
      </div>

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

      {rows.length > 0 && (
        <ul
          role="listbox"
          aria-label="Open pull requests"
          className="flex max-h-[280px] flex-col gap-1 overflow-y-auto"
        >
          {rows.map(({ pr, selected }) => {
            const date = shortDate(pr.updatedAt);
            return (
              <li key={pr.number} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  onClick={() => onChange(pr.number)}
                  className={`flex w-full items-start gap-2.5 rounded-[10px] border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed ${
                    selected
                      ? 'border-primary/60 bg-primary/[0.1]'
                      : 'border-border bg-white/[0.02] hover:border-white/20'
                  }`}
                >
                  <GithubIcon
                    size={14}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[12.5px] text-primary">
                        #{pr.number}
                      </span>
                      <span className="truncate text-[13px] text-foreground">
                        {pr.title || '(no title)'}
                      </span>
                      {pr.isDraft && (
                        <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                          Draft
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                      <span className="truncate">@{pr.author}</span>
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <BranchIcon size={11} className="shrink-0" />
                        <span className="truncate">{pr.headRefName}</span>
                      </span>
                      {date !== null && <span className="shrink-0">· {date}</span>}
                    </span>
                  </span>
                  {selected && (
                    <CheckIcon size={15} className="mt-0.5 shrink-0 text-primary" />
                  )}
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
          className={`flex w-full items-center gap-2 rounded-[10px] border px-3 py-2 text-left text-[13px] transition-colors disabled:cursor-not-allowed ${
            value === manualNumber
              ? 'border-primary/60 bg-primary/[0.1] text-foreground'
              : 'border-dashed border-border text-muted-foreground hover:border-white/20 hover:text-foreground'
          }`}
        >
          <GithubIcon size={14} className="shrink-0 text-primary" />
          Review PR&nbsp;<span className="font-mono text-primary">#{manualNumber}</span>
          <span className="text-[11.5px] text-muted-foreground">
            — not in the open list, review it anyway
          </span>
        </button>
      )}
    </div>
  );
}
