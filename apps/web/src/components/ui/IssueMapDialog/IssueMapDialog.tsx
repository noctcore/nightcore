/** The IssueMapDialog — the human gate before a completed scan's findings are
 *  minted onto GitHub as a native sub-issue map. Cloned from `CreatePRDialog`:
 *  a `<Modal>` gate showing the FULL preview (the exact parent body + every
 *  sub-issue title) with a confirm footer that states precisely what will
 *  happen. Enter is deliberately NOT wired to confirm (no `onEnter` on the
 *  Modal) — an irreversible GitHub write takes an explicit click — and every
 *  close affordance routes through the submitting-aware `requestClose`. */
import { Button } from '../Button';
import { IconButton } from '../IconButton';
import { CloseIcon, GithubIcon } from '../icons';
import { Modal } from '../Modal';
import { Spinner } from '../Spinner';
import { useIssueMapDialog } from './IssueMapDialog.hooks';
import type { IssueMapDialogProps } from './IssueMapDialog.types';
import { IssueMapPreviewBody } from './IssueMapPreviewBody';
import { IssueMapResultBanner } from './IssueMapResultBanner';

const KIND_LABEL: Record<string, string> = {
  insight: 'Insight',
  scorecard: 'Scorecard',
  enforce: 'Enforce',
};

export function IssueMapDialog({
  open,
  scanKind,
  runId,
  onClose,
  override,
}: IssueMapDialogProps) {
  const v = useIssueMapDialog({ open, scanKind, runId, onClose, override });
  const kindLabel = KIND_LABEL[scanKind] ?? scanKind;
  const total = v.preview?.total ?? 0;
  const settled = v.result !== null;

  return (
    <Modal
      open={open}
      label="Export to GitHub"
      panelClassName="w-full max-w-lg"
      onClose={v.requestClose}
    >
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <GithubIcon size={16} />
            Export to GitHub
          </h2>
          <p className="text-xs-plus2 text-muted-foreground">
            {kindLabel} scan map — one parent issue + one sub-issue per finding
          </p>
        </div>
        <IconButton label="Close" onClick={v.requestClose} className="-mr-1 shrink-0">
          <CloseIcon size={16} />
        </IconButton>
      </div>

      <div className="flex max-h-[64vh] flex-col gap-3 overflow-y-auto px-5 pb-2">
        {v.loading && (
          <div
            role="status"
            className="flex items-center gap-2 py-2 text-xs-plus2 text-muted-foreground"
          >
            <Spinner />
            <span>Building preview…</span>
          </div>
        )}

        {v.loadError !== null && (
          <p className="rounded-[8px] border border-destructive/40 bg-destructive/[0.12] px-3 py-2 text-xs-flat text-destructive">
            {v.loadError}
          </p>
        )}

        {settled && v.result !== null && <IssueMapResultBanner result={v.result} />}

        {!settled && v.preview !== null && (
          <IssueMapPreviewBody
            preview={v.preview}
            closeSuperseded={v.closeSuperseded}
            onToggleCloseSuperseded={v.setCloseSuperseded}
            disabled={v.submitting}
          />
        )}

        {v.exportError !== null && (
          <p className="rounded-[8px] border border-destructive/40 bg-destructive/[0.12] px-3 py-2 text-xs-flat text-destructive">
            {v.exportError}
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-2.5 border-t border-border bg-black/15 px-5 py-3.5">
        {settled ? (
          <div className="flex items-center justify-end">
            <Button variant="primary" onClick={v.requestClose}>
              Done
            </Button>
          </div>
        ) : (
          <>
            {v.preview !== null && (
              <p className="text-xs-flat leading-snug text-muted-foreground">
                Open <span className="font-mono text-foreground">1 parent issue</span> +{' '}
                <span className="font-mono text-foreground">
                  {total} {total === 1 ? 'sub-issue' : 'sub-issues'}
                </span>{' '}
                on GitHub. This cannot be undone from here.
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={v.requestClose} disabled={v.submitting}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!v.canConfirm} onClick={v.confirm}>
                {v.submitting ? (
                  <>
                    <Spinner />
                    <span>
                      Creating… {v.progress?.created ?? 0}/{v.progress?.total ?? total}
                    </span>
                  </>
                ) : (
                  <>
                    <GithubIcon size={15} />
                    Export to GitHub
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
