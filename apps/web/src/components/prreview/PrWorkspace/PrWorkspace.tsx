/** The PR Review workspace panel (right side of the permanent two-panel layout):
 *  the selected PR's header (state/number/title/author/labels), the live STATUS
 *  BLOCK, the collapsible description, and the registry-driven REVIEW SECTION.
 *  The PR body is UNTRUSTED contributor markdown — rendered through the
 *  sanitizing `Markdown` primitive (marked + DOMPurify), never raw. */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  LayersIcon,
  Markdown,
  RetryIcon,
  Spinner,
  StatusDot,
} from '@/components/ui';

import { lifecycleToneClasses } from '../prreview-lifecycle';
import { PrStatusBlock } from '../PrStatusBlock';
import { ReviewSection } from '../ReviewSection';
import {
  formatPrDate,
  labelChipStyle,
  useChangedFiles,
  useDescriptionCollapse,
} from './PrWorkspace.hooks';
import type { PrWorkspaceProps } from './PrWorkspace.types';

/** State-badge tones for the gh summary vocabulary (unknown → open styling —
 *  the list is open-only, so anything else only appears via a stale summary). */
function stateBadgeClass(state: string): string {
  if (state === 'MERGED') return 'border-primary/40 bg-primary/10 text-primary';
  if (state === 'CLOSED')
    return 'border-destructive/40 bg-destructive/10 text-destructive';
  return 'border-success/40 bg-success/10 text-success';
}

export function PrWorkspace({
  prNumber,
  pr,
  onOpenExternal,
  review,
  lifecycle,
  statusView,
  statusOverride,
  statusActions,
  changedFilesOverride,
}: PrWorkspaceProps) {
  const date = pr !== null ? formatPrDate(pr.createdAt) : null;
  const body = pr?.body ?? '';
  const description = useDescriptionCollapse(prNumber, body);
  const changed = useChangedFiles(prNumber, changedFilesOverride);
  const tone =
    lifecycle != null ? lifecycleToneClasses(lifecycle.tone) : null;

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-8 py-7">
      {/* Header: state + number + open-on-GitHub */}
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2">
          <span
            className={`rounded-full border px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide ${stateBadgeClass(pr?.state ?? 'OPEN')}`}
          >
            {pr?.state === 'CLOSED'
              ? 'Closed'
              : pr?.state === 'MERGED'
                ? 'Merged'
                : 'Open'}
          </span>
          <span className="font-mono text-xs-plus2 text-muted-foreground">
            #{prNumber}
          </span>
          {pr?.isDraft === true && (
            <span className="rounded-full border border-border px-1.5 py-px text-3xs uppercase tracking-wide text-muted-foreground">
              Draft
            </span>
          )}
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
        {pr !== null && pr.title.length > 0 ? pr.title : `Pull request #${prNumber}`}
      </h2>

      {/* Review-position status line: where this PR sits on the review
          lifecycle (dot + label + one-line description). role=status so a
          transition (reviewing → reviewed → posted → stale) is announced. */}
      {lifecycle != null && tone != null && (
        <div
          role="status"
          className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-nc border px-3.5 py-2 ${tone.border} ${tone.bg}`}
        >
          <StatusDot colorClass={tone.dot} pulse={lifecycle.pulse} glow />
          <span className={`text-xs-plus font-semibold ${tone.text}`}>
            {lifecycle.label}
          </span>
          <span className="text-xs-flat text-muted-foreground">
            {lifecycle.description}
          </span>
        </div>
      )}

      {/* Meta + labels */}
      {pr !== null && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs-plus2 text-muted-foreground">
            <span>@{pr.author}</span>
            {date !== null && <span>· {date}</span>}
          </div>
          {pr.labels.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pr.labels.map((label) => (
                <span
                  key={label.name}
                  style={labelChipStyle(label.color)}
                  className="rounded-full border border-border px-2 py-0.5 text-2xs-plus font-medium text-muted-foreground"
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {pr === null && (
        <p className="text-xs-plus text-muted-foreground">
          This PR isn&apos;t in the open list — Nightcore will review it by number.
        </p>
      )}

      {/* Changed files: a clickable count expanding to a per-file list
          (path · +additions / -deletions), scrollable past ~12 rows, with its
          own loading / error / empty states. Fetches lazily on first open (works
          for a typed-number PR too); paths are gh pass-through, rendered inert. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={changed.toggle}
            aria-expanded={changed.expanded}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white/[0.02] px-2.5 py-1 text-xs-plus font-medium text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground"
          >
            {changed.loading ? <Spinner size={12} /> : <LayersIcon size={13} />}
            <span>
              {changed.count !== null
                ? `${changed.count} ${changed.count === 1 ? 'file' : 'files'}`
                : 'Files'}
            </span>
            {changed.expanded ? (
              <ChevronDownIcon size={12} />
            ) : (
              <ChevronRightIcon size={12} />
            )}
          </button>
          {pr !== null && (pr.additions > 0 || pr.deletions > 0) && (
            <span className="inline-flex items-center gap-1.5 font-mono text-2xs-plus">
              <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">
                +{pr.additions}
              </span>
              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
                -{pr.deletions}
              </span>
            </span>
          )}
        </div>
        {changed.expanded && (
          <div
            className="overflow-hidden rounded-nc border border-border"
            style={{ animation: 'nc-rise var(--nc-motion-fast) var(--nc-ease-out-quint)' }}
          >
            {changed.loading ? (
              <div
                role="status"
                className="flex items-center gap-2 px-3 py-3 text-xs-plus text-muted-foreground"
              >
                <Spinner size={13} /> Loading changed files…
              </div>
            ) : changed.error !== null ? (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 px-3 py-3 text-xs-plus text-destructive"
              >
                <span className="min-w-0 break-words">{changed.error}</span>
                <button
                  type="button"
                  onClick={changed.retry}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-2xs-plus font-medium text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground"
                >
                  <RetryIcon size={12} /> Retry
                </button>
              </div>
            ) : changed.files.length === 0 ? (
              <p className="px-3 py-3 text-xs-plus text-muted-foreground">
                No changed files reported.
              </p>
            ) : (
              <ul className="max-h-[300px] divide-y divide-border overflow-y-auto">
                {changed.files.map((file, i) => (
                  <li
                    key={`${file.path}-${i}`}
                    className="flex items-center gap-3 px-3 py-1.5"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs-flat text-foreground"
                      title={file.path}
                    >
                      {file.path}
                    </span>
                    <span className="shrink-0 font-mono text-2xs">
                      <span className="text-success">+{file.additions}</span>{' '}
                      <span className="text-destructive">-{file.deletions}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Live GitHub status (fetch on selection + manual refresh, no polling).
          The app lifts the fetch into the view model and passes it as `view`;
          stories/tests use the `override` seam. */}
      <PrStatusBlock
        prNumber={prNumber}
        view={statusView}
        override={statusOverride}
        actions={statusActions}
      />

      {/* Description (untrusted markdown → sanitized), collapsible when long. */}
      {pr !== null && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
              Description
            </span>
            {/* The threat-model detail rides in the title; the visible chrome is
                a single quiet "sanitized" pill instead of a jargon annotation. */}
            <span
              title="Untrusted contributor content · sanitized"
              className="rounded-full border border-border px-1.5 py-px text-3xs uppercase tracking-wide text-muted-foreground/70"
            >
              sanitized
            </span>
          </div>
          {body.trim().length > 0 ? (
            <>
              <div
                className={
                  description.expanded
                    ? undefined
                    : 'relative max-h-[220px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]'
                }
              >
                <Markdown>{body}</Markdown>
              </div>
              {description.collapsible && (
                <button
                  type="button"
                  onClick={description.toggle}
                  aria-expanded={description.expanded}
                  className="inline-flex w-fit items-center gap-1 text-xs-flat font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {description.expanded ? (
                    <ChevronDownIcon size={13} />
                  ) : (
                    <ChevronRightIcon size={13} />
                  )}
                  {description.expanded ? 'Show less' : 'Show full description'}
                </button>
              )}
            </>
          ) : (
            <p className="text-xs-plus2 text-muted-foreground">
              No description provided.
            </p>
          )}
        </div>
      )}

      {/* The per-PR review area, driven by the run registry. */}
      <ReviewSection {...review} />
    </div>
  );
}
