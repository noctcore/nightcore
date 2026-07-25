/** The per-PR FIX status strip inside the ReviewSection's results mode: one
 *  card per lifecycle state — RUNNING (spinner + cancel), COMMITTING (spinner),
 *  AWAITING_PUSH (the session summary + the human-gated "Push to PR" + the
 *  local-commit note), PUSHED (success + re-review), FAILED (error + dismiss).
 *  Non-failed cards are `role="status"` live regions (failed keeps
 *  `role="alert"`) so lifecycle flips are announced; the per-card context rides
 *  as sr-only text, never as `aria-label` on a generic div. The summary is
 *  MODEL TEXT rendered through the sanitizing `Markdown` primitive (marked +
 *  DOMPurify + hardened anchors) — the same treatment as assistant turns and
 *  the untrusted PR description, never raw HTML. An unknown future status
 *  renders nothing (forward-compatible). */
import {
  AlertIcon,
  Button,
  CheckIcon,
  CloseIcon,
  Markdown,
  RefactorIcon,
  RetryIcon,
  Spinner,
  StopIcon,
  UploadIcon,
} from '@/components/ui';

import { FixDiffPreview } from '../FixDiffPreview';
import { LOCAL_COMMIT_NOTE, runningLabel } from './FixRunCard.hooks';
import type { FixRunCardProps } from './FixRunCard.types';

export function FixRunCard({
  fix,
  pushing,
  onCancel,
  onRequestPush,
  onReReview,
  onDismiss,
  onTryAgain,
}: FixRunCardProps) {
  if (fix.status === 'running') {
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-nc border border-border bg-white/[0.02] px-4 py-3"
      >
        <Spinner size={14} />
        <span className="text-xs-plus text-muted-foreground">
          <span className="sr-only">{`PR #${fix.prNumber} fix in progress: `}</span>
          {runningLabel(fix)}
        </span>
        <Button variant="danger" className="ml-auto shrink-0" onClick={onCancel}>
          <StopIcon size={13} />
          Cancel fix
        </Button>
      </div>
    );
  }

  // The session finished and its commit is being written — a transient Rust
  // state between running and awaiting_push. No actions: cancelling mid-commit
  // would tear a half-written commit, and there is nothing to push yet.
  if (fix.status === 'committing') {
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-nc border border-border bg-white/[0.02] px-4 py-3"
      >
        <Spinner size={14} />
        <span className="text-xs-plus text-muted-foreground">
          <span className="sr-only">{`PR #${fix.prNumber} fix: `}</span>
          Committing changes…
        </span>
      </div>
    );
  }

  if (fix.status === 'awaiting_push') {
    return (
      <div
        role="status"
        className="flex flex-col gap-3 rounded-nc border border-primary/40 bg-primary/[0.06] px-4 py-3"
      >
        <span className="sr-only">{`PR #${fix.prNumber} fix awaiting push.`}</span>
        <div className="flex items-center gap-2">
          <RefactorIcon size={14} className="shrink-0 text-primary" />
          <span className="text-xs-plus font-medium text-foreground">
            Fix ready on{' '}
            <span className="font-mono text-foreground">{fix.branch}</span>
          </span>
          <Button
            className="ml-auto shrink-0"
            disabled={pushing}
            aria-busy={pushing}
            onClick={onRequestPush}
          >
            {pushing ? <Spinner size={13} /> : <UploadIcon size={13} />}
            Push to PR
          </Button>
        </div>
        {/* The push-gate trust view: the ACTUAL local commit diff, so the human
            approves the real change rather than the model's prose below. */}
        <FixDiffPreview fixId={fix.id} />
        {fix.summary !== null && fix.summary.trim().length > 0 && (
          // Model-authored result text through the SANITIZING Markdown
          // primitive (headings/lists/inline code render; scripts/handlers
          // are stripped, anchors hardened) — scrollable past a screenful so
          // a long summary never swallows the card's actions.
          <div className="max-h-[420px] overflow-y-auto">
            <Markdown className="text-xs-plus text-muted-foreground">
              {fix.summary}
            </Markdown>
          </div>
        )}
        <p className="text-2xs-plus text-muted-foreground/70">{LOCAL_COMMIT_NOTE}</p>
      </div>
    );
  }

  if (fix.status === 'pushed') {
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-nc border border-success/40 bg-success/[0.06] px-4 py-3"
      >
        <CheckIcon size={14} className="shrink-0 text-success" />
        <span className="text-xs-plus text-muted-foreground">
          Fix pushed to{' '}
          <span className="font-mono text-foreground">{fix.branch}</span> on PR #
          {fix.prNumber}.
        </span>
        <Button variant="secondary" className="ml-auto shrink-0" onClick={onReReview}>
          <RetryIcon size={13} />
          Re-review
        </Button>
      </div>
    );
  }

  if (fix.status === 'failed') {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-nc border border-destructive/40 bg-destructive/[0.08] px-4 py-3"
      >
        <span className="sr-only">{`PR #${fix.prNumber}: `}</span>
        <AlertIcon size={14} className="mt-0.5 shrink-0 text-destructive" />
        <span className="text-xs-plus text-destructive">
          {fix.error !== null && fix.error.length > 0
            ? `Fix failed: ${fix.error}`
            : 'Fix failed.'}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Retry re-arms the address gate (the ConfirmDialog reopens) so a
              failed fix can be re-run on the current selection. */}
          {onTryAgain !== undefined && (
            <Button variant="secondary" onClick={onTryAgain}>
              <RetryIcon size={13} />
              Try again
            </Button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss fix status"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </div>
    );
  }

  return null;
}
