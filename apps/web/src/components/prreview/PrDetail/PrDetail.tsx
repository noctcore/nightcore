/** The PR Review detail pane (right side of the master-detail): the selected PR's
 *  header/labels/description plus the run configuration and the Review action. The
 *  PR body is UNTRUSTED contributor markdown — rendered through the sanitizing
 *  `Markdown` primitive (marked + DOMPurify), never raw. */
import {
  Button,
  ExternalLinkIcon,
  GithubIcon,
  Markdown,
  ModelEffortPicker,
  Spinner,
} from '@/components/ui';

import { ALL_LENSES, LENS_META } from '../prreview.constants';
import { formatPrDate, labelChipStyle } from './PrDetail.hooks';
import type { PrDetailProps } from './PrDetail.types';

const CHIP =
  'rounded-[10px] border px-3 py-1.5 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

function chipClass(selected: boolean): string {
  return `${CHIP} ${
    selected
      ? 'border-primary/60 bg-primary/[0.1] text-foreground'
      : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
  }`;
}

export function PrDetail({
  pr,
  selectedNumber,
  config,
  isStarting,
  onReview,
  onOpenExternal,
}: PrDetailProps) {
  if (selectedNumber === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <GithubIcon size={44} className="text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          Select a pull request to review
        </p>
      </div>
    );
  }

  const {
    model,
    setModel,
    effort,
    setEffort,
    selected,
    toggle,
    selectAll,
    selectNone,
    orderedSelected,
    canReview,
  } = config;
  const lensCount = orderedSelected.length;
  const date = pr !== null ? formatPrDate(pr.createdAt) : null;

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-8 py-8">
      {/* Header: state + number + open-on-GitHub */}
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2">
          <span className="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success">
            {pr?.state === 'CLOSED'
              ? 'Closed'
              : pr?.state === 'MERGED'
                ? 'Merged'
                : 'Open'}
          </span>
          <span className="font-mono text-[13px] text-muted-foreground">
            #{selectedNumber}
          </span>
        </span>
        {pr !== null && pr.url.length > 0 && (
          <button
            type="button"
            onClick={() => onOpenExternal(pr.url)}
            aria-label="Open on GitHub"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            <ExternalLinkIcon size={16} />
          </button>
        )}
      </div>

      {/* Title */}
      <h2 className="text-2xl font-semibold leading-snug text-foreground">
        {pr !== null && pr.title.length > 0
          ? pr.title
          : `Pull request #${selectedNumber}`}
      </h2>

      {/* Meta + labels */}
      {pr !== null && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span>@{pr.author}</span>
            {date !== null && <span>· {date}</span>}
            {pr.isDraft && (
              <span className="rounded-full border border-border px-1.5 py-px text-[10px] uppercase tracking-wide">
                Draft
              </span>
            )}
          </div>
          {pr.labels.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pr.labels.map((label) => (
                <span
                  key={label.name}
                  style={labelChipStyle(label.color)}
                  className="rounded-full border border-border px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground"
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {pr === null && (
        <p className="text-[12.5px] text-muted-foreground">
          This PR isn&apos;t in the open list — Nightcore will review it by number.
        </p>
      )}

      {/* Run configuration + the Review action */}
      <div className="flex flex-col gap-5 rounded-[14px] border border-border bg-white/[0.02] p-5">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Lenses ({lensCount}/{ALL_LENSES.length})
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={selectAll}
                className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                All
              </button>
              <button
                type="button"
                onClick={selectNone}
                className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                None
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_LENSES.map((lens) => {
              const Meta = LENS_META[lens];
              const Icon = Meta.icon;
              const on = selected.has(lens);
              return (
                <button
                  key={lens}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(lens)}
                  className={`inline-flex items-center gap-1.5 ${chipClass(on)}`}
                >
                  <Icon size={13} />
                  {Meta.label}
                </button>
              );
            })}
          </div>
        </div>

        <ModelEffortPicker
          model={model}
          effort={effort}
          onChangeModel={setModel}
          onChangeEffort={setEffort}
        />

        <div className="flex flex-col gap-2">
          <Button
            disabled={!canReview || isStarting}
            aria-busy={isStarting}
            onClick={onReview}
            className="w-full sm:w-auto"
          >
            {isStarting ? <Spinner size={15} /> : <GithubIcon size={15} />}
            {isStarting ? 'Starting…' : `Review PR #${selectedNumber}`}
          </Button>
          <p className="text-[12px] text-muted-foreground">
            Reviews the PR diff across {lensCount}{' '}
            {lensCount === 1 ? 'lens' : 'lenses'} — no checkout, read-only · ~Claude{' '}
            {model ?? 'default'}.
          </p>
        </div>
      </div>

      {/* Description (untrusted markdown → sanitized) */}
      {pr !== null && (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            Description
          </span>
          {pr.body.trim().length > 0 ? (
            <Markdown>{pr.body}</Markdown>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              No description provided.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
