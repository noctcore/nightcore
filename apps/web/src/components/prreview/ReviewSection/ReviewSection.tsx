/** The PR Review workspace's REVIEW SECTION: the selected PR's run area in one
 *  of three states — CONFIG (lens chips + model/effort + Review), RUNNING
 *  (compact per-lens progress + cancel), RESULTS (failure banners, the
 *  human-gated post toolbar, and the findings grid) — plus the per-PR history
 *  menu and the "viewing past run" affordance. Purely presentational; every
 *  piece of state lives in the PrReviewView model, so switching PRs re-renders
 *  this section while every run keeps streaming in the registry. */
import { useId } from 'react';

import {
  Button,
  CheckIcon,
  chipClass,
  GithubIcon,
  HistoryIcon,
  Menu,
  ModelSelectField,
  MoveIcon,
  RefactorIcon,
  RetryIcon,
  RunProgress,
  Spinner,
  StopIcon,
} from '@/components/ui';
import { PROVIDER_LABEL } from '@/lib/bridge';

import { FixRunCard } from '../FixRunCard';
import { ALL_LENSES, LENS_META, VERDICT_META } from '../prreview.constants';
import {
  FIX_RUNNING_TITLE,
  OWN_PR_TITLE,
  sectionStatusMessage,
} from '../prreview.constants';
import type { ReviewVerdict } from '../prreview.types';
import { ReviewFindings } from '../ReviewFindings';
import { ReviewPosition } from '../ReviewPosition';
import { ReviewTimeline } from '../ReviewTimeline';
import type { ReviewSectionProps } from './ReviewSection.types';

/** The three post-review verdict buttons, in display order. */
const VERDICTS: ReviewVerdict[] = ['approve', 'request-changes', 'comment'];

export function ReviewSection({
  prNumber,
  mode,
  stream,
  configure,
  running,
  results,
  history,
}: ReviewSectionProps) {
  const { config } = configure;
  const lensCount = config.orderedSelected.length;
  const { toolbar } = results;
  // Ids for the sr-only disabled-reason spans the guarded toolbar buttons point
  // at via aria-describedby (`useId` is render-safe — allowlisted by the
  // no-state-in-component-body rule).
  const reasonsId = useId();
  const ownPrReasonId = `${reasonsId}-own-pr`;
  const fixRunningReasonId = `${reasonsId}-fix-running`;

  return (
    <section aria-label={`PR #${prNumber} review`} className="flex flex-col gap-3">
      {/* Persistent run-state announcement: one polite live region across all
          three modes, so config→running→results transitions are audible. */}
      <span role="status" aria-live="polite" className="sr-only">
        {sectionStatusMessage(mode, stream)}
      </span>

      {/* Section header: label + the per-PR history + results-mode actions. */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          Review
        </span>
        <div className="ml-auto flex items-center gap-2">
          {history.items.length > 0 && (
            <Menu
              label={`PR #${prNumber} run history`}
              items={history.items}
              align="right"
              trigger={
                <Button variant="ghost">
                  <HistoryIcon size={13} />
                  History
                </Button>
              }
            />
          )}
          {mode === 'results' && (
            <Button variant="ghost" onClick={results.onNewReview}>
              <RetryIcon size={13} />
              New review
            </Button>
          )}
        </div>
      </div>

      {/* Past-run affordance: the displayed stream is a history selection. */}
      {history.viewingPastRun && (
        <div className="flex items-center gap-3 rounded-[10px] border border-primary/40 bg-primary/[0.06] px-4 py-2 text-[12.5px] text-muted-foreground">
          <HistoryIcon size={14} className="shrink-0 text-primary" />
          Viewing a past review run.
          <button
            type="button"
            onClick={history.onBackToLatest}
            className="ml-auto shrink-0 font-medium text-primary transition-colors hover:brightness-110"
          >
            Back to latest
          </button>
        </div>
      )}

      {mode === 'config' && (
        <div className="flex flex-col gap-5 rounded-[14px] border border-border bg-white/[0.02] p-5">
          {configure.startError !== null && (
            <p
              role="alert"
              className="rounded-[10px] border border-destructive/40 bg-destructive/[0.1] px-4 py-2 text-[12.5px] text-destructive"
            >
              {configure.startError}
            </p>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                Lenses ({lensCount}/{ALL_LENSES.length})
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={config.selectAll}
                  className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={config.selectNone}
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
                const on = config.selected.has(lens);
                return (
                  <button
                    key={lens}
                    type="button"
                    aria-pressed={on}
                    onClick={() => config.toggle(lens)}
                    className={`inline-flex items-center gap-1.5 ${chipClass(on)}`}
                  >
                    <Icon size={13} />
                    {Meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          <ModelSelectField
            value={{ model: config.model, effort: config.effort }}
            onChange={(sel) => {
              config.setModel(sel.model);
              config.setEffort(sel.effort);
            }}
          />

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={!config.canRun || configure.isStarting}
                aria-busy={configure.isStarting}
                onClick={configure.onReview}
              >
                {configure.isStarting ? <Spinner size={15} /> : <GithubIcon size={15} />}
                {configure.isStarting ? 'Starting…' : `Review PR #${prNumber}`}
              </Button>
              {configure.onBackToResults !== null && (
                <Button variant="ghost" onClick={configure.onBackToResults}>
                  Back to results
                </Button>
              )}
            </div>
            <p className="text-[12px] text-muted-foreground">
              Reviews the PR diff across {lensCount}{' '}
              {lensCount === 1 ? 'lens' : 'lenses'} — no checkout, read-only ·
              ~{PROVIDER_LABEL} {config.model ?? 'default'}.
            </p>
          </div>
        </div>
      )}

      {mode === 'running' && stream !== null && (
        <div className="flex flex-col gap-4">
          <RunProgress
            status="running"
            categories={running.categories}
            categoryState={stream.lensState}
            findingCounts={running.findingCounts}
            unitLabel="lenses"
            costUsd={stream.costUsd}
            usage={stream.usage}
            durationMs={stream.durationMs}
          />
          <div className="flex justify-end">
            <Button variant="danger" onClick={running.onCancel}>
              <StopIcon size={15} />
              Cancel review
            </Button>
          </div>
        </div>
      )}

      {mode === 'results' && stream !== null && (
        <div className="flex flex-col gap-3">
          {stream.status === 'failed' &&
            (stream.failureReason === 'aborted' ? (
              <div className="rounded-[10px] border border-border bg-white/[0.02] px-4 py-3 text-[12.5px] text-muted-foreground">
                Review cancelled. Any findings gathered before you stopped are
                shown below.
              </div>
            ) : (
              <div className="rounded-[10px] border border-destructive/40 bg-destructive/[0.08] px-4 py-3 text-[12.5px] text-destructive">
                {stream.error ?? 'Review failed.'}
              </div>
            ))}

          {/* The review-position layer: reconciliation banner, staleness chip,
              merge verdict, and follow-up summary (self-hides when empty). */}
          {results.position !== undefined && <ReviewPosition {...results.position} />}

          {/* The review-arc timeline — a vertical stepper unifying what History +
              FixRunCard show separately (self-hides when there's no arc). */}
          <ReviewTimeline steps={results.timeline} />

          {stream.status === 'completed' && (
            <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
              <Button
                aria-busy={toolbar.bulkConverting}
                aria-disabled={toolbar.openCount === 0 || toolbar.bulkConverting}
                onClick={toolbar.onConvertAll}
                variant="secondary"
                className={
                  toolbar.openCount === 0 || toolbar.bulkConverting
                    ? 'cursor-not-allowed opacity-40'
                    : undefined
                }
              >
                <MoveIcon size={15} />
                {toolbar.bulkConverting
                  ? `Converting… ${toolbar.bulkProgress.done}/${toolbar.bulkProgress.total}`
                  : `Convert all to tasks (${toolbar.openCount})`}
              </Button>
              {/* Sr-only disabled reasons: the guarded buttons below stay
                  focusable (aria-disabled, the convert-all precedent) and point
                  here via aria-describedby so keyboard/SR users hear WHY. The
                  `title` twins stay for mouse hover. */}
              <span id={ownPrReasonId} className="sr-only">
                {OWN_PR_TITLE}
              </span>
              <span id={fixRunningReasonId} className="sr-only">
                {FIX_RUNNING_TITLE}
              </span>

              {/* Address findings: opens the ConfirmDialog (the human gate for
                  starting a paid agent session that commits to the PR branch —
                  never auto-fires). Enabled by the OPEN selection; inert (but
                  still focusable) while this PR already has a fix in flight. */}
              <Button
                variant="secondary"
                aria-disabled={!toolbar.canAddress}
                aria-describedby={
                  toolbar.fixRunning ? fixRunningReasonId : undefined
                }
                title={toolbar.fixRunning ? FIX_RUNNING_TITLE : undefined}
                onClick={() => {
                  if (toolbar.canAddress) toolbar.requestAddress();
                }}
                className={
                  !toolbar.canAddress ? 'cursor-not-allowed opacity-40' : undefined
                }
              >
                <RefactorIcon size={15} />
                Address findings ({toolbar.addressCount})
              </Button>
              {toolbar.bulkError !== null && (
                <span className="text-[12px] text-destructive">
                  {toolbar.bulkError}
                </span>
              )}
              {toolbar.addressError !== null && (
                <span className="text-[12px] text-destructive">
                  {toolbar.addressError}
                </span>
              )}

              {/* Post-review toolbar: the three human-gated verdicts. Each opens
                  the ConfirmDialog — none auto-fires. Approve/request-changes
                  guard inert on the viewer's OWN PR (GitHub rejects them) but
                  stay focusable so the aria-describedby reason is reachable. */}
              <div className="ml-auto flex items-center gap-2">
                {/* Post-success micro-feedback: an auto-clearing confirmation the
                    view model shows for a few seconds after a verdict posts.
                    role=status announces it; the rise animation is neutralized
                    under prefers-reduced-motion by the global CSS rule. */}
                {toolbar.postedFeedback !== null && (
                  <span
                    role="status"
                    className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/[0.1] px-2.5 py-1 text-[11.5px] font-medium text-success"
                    style={{ animation: 'nc-rise .18s cubic-bezier(.22,1,.36,1)' }}
                  >
                    <CheckIcon size={13} />
                    Posted {toolbar.postedFeedback}{' '}
                    {toolbar.postedFeedback === 1 ? 'finding' : 'findings'}
                  </span>
                )}
                <span className="font-mono text-[11px] text-muted-foreground">
                  {toolbar.selectedCount} selected
                </span>
                {VERDICTS.map((verdict) => {
                  const meta = VERDICT_META[verdict];
                  const Icon = meta.icon;
                  const guarded = toolbar.ownPr && verdict !== 'comment';
                  const inert = !toolbar.canPost || guarded;
                  return (
                    <Button
                      key={verdict}
                      variant={meta.destructive ? 'danger' : 'secondary'}
                      aria-disabled={inert}
                      aria-describedby={guarded ? ownPrReasonId : undefined}
                      title={guarded ? OWN_PR_TITLE : undefined}
                      onClick={() => {
                        if (!inert) toolbar.requestPost(verdict);
                      }}
                      className={inert ? 'cursor-not-allowed opacity-40' : undefined}
                    >
                      <Icon size={15} />
                      {meta.label}
                    </Button>
                  );
                })}
              </div>

              <span role="status" aria-live="polite" className="sr-only">
                {toolbar.bulkStatusMessage}
              </span>
            </div>
          )}

          {/* The PR's fix lifecycle strip — per-PR (registry), so it survives
              PR switches and renders regardless of the displayed run's status. */}
          {results.fix !== null && <FixRunCard {...results.fix} />}

          <ReviewFindings
            findings={results.gridFindings}
            emptyMessage={results.emptyMessage}
            emptyVariant={results.emptyVariant}
            selection={results.selection}
            onToggleSelect={results.onToggleSelect}
            onSelectionChange={results.onSelectionChange}
            onOpen={results.onOpenFinding}
            recurringFingerprints={results.position?.followup?.recurringFingerprints}
          />
        </div>
      )}
    </section>
  );
}
