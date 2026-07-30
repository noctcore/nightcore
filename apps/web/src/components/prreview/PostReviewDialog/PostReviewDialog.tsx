/**
 * The POST-REVIEW human gate (#197 slice 3): a ConfirmDialog that opens PRE-FILLED —
 * the verdict recommended by the run's mechanically-clamped merge verdict, and the
 * pre-selected inline / body split of the chosen findings — so posting is a review of
 * a prepared draft instead of a from-scratch decision (the friction behind "11–28
 * findings per review, zero ever posted").
 *
 * Everything here is editable and nothing here is binding:
 *  - the verdict selector re-arms the gate on any other verdict (own-PR-guarded
 *    upstream, since GitHub refuses approve/request-changes on your own pull request);
 *  - the split toggle promotes every anchorable finding to an inline comment.
 *
 * THE HUMAN ALWAYS CONFIRMS. `post.confirmPost` is the single call that reaches
 * GitHub, and the only thing that invokes it is this dialog's confirm button — there
 * is no effect, no timer, and no auto-post path anywhere in the gate.
 */
import { Checkbox, ConfirmDialog } from '@/components/ui';

import { VERDICT_META } from '../prreview.constants';
import { describePostGate, POST_VERDICTS } from './PostReviewDialog.hooks';
import type { PostReviewDialogProps } from './PostReviewDialog.types';

export function PostReviewDialog({ post }: PostReviewDialogProps) {
  const { meta, isRecommended, clampNote } = describePostGate(post);

  return (
    <ConfirmDialog
      open={meta !== null}
      title={meta?.confirmTitle ?? ''}
      confirmLabel={meta?.confirmLabel ?? 'Confirm'}
      destructive={meta?.destructive ?? false}
      busy={post.posting}
      onConfirm={post.confirmPost}
      onCancel={post.cancelPost}
      message={
        meta === null ? null : (
          <div className="flex flex-col gap-3">
            <span>
              Post{' '}
              <span className="font-semibold text-foreground">
                {meta.label.toLowerCase()}
              </span>{' '}
              on{' '}
              <span className="font-mono text-foreground">PR #{post.postPrNumber}</span>{' '}
              with{' '}
              <span className="font-semibold text-foreground">{post.selectedCount}</span>{' '}
              selected {post.selectedCount === 1 ? 'finding' : 'findings'}?
            </span>

            {/* The pre-filled verdict, and WHY. A clamped run says so, so the
                recommendation is never a black box. */}
            <p className="text-2xs-plus leading-relaxed text-muted-foreground">
              {isRecommended ? (
                <>
                  <span className="font-medium text-primary">Pre-filled</span> from this
                  review&apos;s merge verdict.
                </>
              ) : (
                <>
                  Recommended:{' '}
                  <span className="font-medium text-foreground">
                    {VERDICT_META[post.recommendedVerdict].label}
                  </span>
                  .
                </>
              )}
              {clampNote.length > 0 && <> {clampNote}.</>}
            </p>

            {/* Edit the verdict without leaving the gate. */}
            <div
              role="group"
              aria-label="Review verdict"
              className="flex flex-wrap items-center gap-1.5"
            >
              {POST_VERDICTS.map((option) => {
                const active = option === post.postVerdict;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    disabled={post.posting}
                    onClick={() => post.requestPost(option)}
                    className={`rounded-full border px-2.5 py-1 text-2xs-plus font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      active
                        ? 'border-primary/50 bg-primary/[0.12] text-foreground'
                        : 'border-border bg-white/[0.02] text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {VERDICT_META[option].label}
                  </button>
                );
              })}
            </div>

            {/* The pre-selected inline/body split. Both halves are posted — this
                only decides where each finding lands. */}
            <p className="text-2xs-plus leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">
                {post.selectedInlineCount}
              </span>{' '}
              inline {post.selectedInlineCount === 1 ? 'comment' : 'comments'} ·{' '}
              <span className="font-medium text-foreground">
                {post.selectedBodyCount}
              </span>{' '}
              in the review body. Inline anchors are re-validated against the PR&apos;s
              current diff when posting; any that no longer fit move into the body.
            </p>

            <Checkbox
              checked={post.postAllInline}
              onChange={post.setPostAllInline}
              disabled={post.posting}
              label="Post every anchorable finding inline (including low and info)"
            />

            {post.postError !== null && (
              <span
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/[0.1] px-3 py-2 text-xs-plus text-destructive"
              >
                {post.postError}
              </span>
            )}
          </div>
        )
      }
    />
  );
}
