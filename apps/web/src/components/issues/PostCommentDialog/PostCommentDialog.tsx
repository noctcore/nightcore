/** The post-as-comment preview dialog — the human gate on the only GitHub write in
 *  this feature. It shows the EXACT markdown the Rust post will send (built by the
 *  same builder, so it is byte-identical), and the Post button stays disabled until
 *  the user ticks the confirmation. Enter is deliberately NOT wired to post; posting
 *  requires an explicit click. Nothing posts automatically. */
import {
  AlertIcon,
  Button,
  Checkbox,
  GithubIcon,
  Markdown,
  Modal,
  Spinner,
  useLastPresent,
} from '@/components/ui';

import { usePostConfirm } from './PostCommentDialog.hooks';
import type { PostCommentDialogProps } from './PostCommentDialog.types';

export function PostCommentDialog({
  open,
  body,
  loading,
  error,
  posting,
  onClose,
  onPost,
}: PostCommentDialogProps) {
  const { confirmed, setConfirmed } = usePostConfirm(open);
  // Retain the last body across the exit animation so the panel doesn't blank out.
  const shownBody = useLastPresent(open ? body : null) ?? body;
  const canPost = confirmed && !loading && !posting && shownBody.trim().length > 0;

  return (
    <Modal
      open={open}
      role="dialog"
      label="Preview comment before posting"
      initialFocus="[data-cancel]"
      panelClassName="w-full max-w-lg"
      onClose={onClose}
    >
      <div className="flex flex-col gap-2 px-5 pb-3 pt-5">
        <h2 className="text-base font-semibold text-foreground">Post verdict as a GitHub comment</h2>
        <p className="text-xs-plus leading-relaxed text-muted-foreground">
          This posts the comment below to the issue on GitHub. Review the exact markdown
          first — nothing is posted until you confirm.
        </p>
      </div>

      <div className="max-h-[46vh] overflow-y-auto px-5 pb-3">
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs-plus2 text-muted-foreground">
            <Spinner size={14} /> Building the comment…
          </div>
        ) : error !== null ? (
          <div className="flex items-center gap-2 rounded-[10px] border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-xs-plus text-destructive">
            <AlertIcon size={14} />
            {error}
          </div>
        ) : (
          <div className="rounded-[10px] border border-border bg-white/[0.02] px-3.5 py-2.5">
            <Markdown>{shownBody}</Markdown>
          </div>
        )}
      </div>

      <div className="px-5 pb-3">
        <Checkbox
          checked={confirmed}
          onChange={setConfirmed}
          disabled={loading || posting || error !== null}
          label="I've reviewed the comment above and want to post it to GitHub."
        />
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        <Button data-cancel variant="ghost" disabled={posting} onClick={onClose}>
          Cancel
        </Button>
        <Button
          data-post
          disabled={!canPost}
          aria-busy={posting}
          aria-disabled={!canPost}
          onClick={onPost}
        >
          {posting ? <Spinner size={14} /> : <GithubIcon size={15} />}
          Post comment
        </Button>
      </div>
    </Modal>
  );
}
