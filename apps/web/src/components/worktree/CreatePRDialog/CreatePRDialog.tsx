import {
  BranchIcon,
  BranchPicker,
  Button,
  Checkbox,
  CloseIcon,
  IconButton,
  Modal,
  Spinner,
} from '@/components/ui';

import { useCreatePrDialog } from './CreatePRDialog.hooks';
import type { CreatePRDialogProps } from './CreatePRDialog.types';

const INPUT_CLASS =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';
const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground';

/** The Create PR dialog — the human gate before anything leaves the machine:
 *  an editable title/body pre-filled by `draftPrMessage` (never posted without
 *  review), a base-branch picker, a draft toggle, and a confirm footer that
 *  states exactly what will happen. Built on the shared `<Modal>` primitive
 *  (focus trap + Esc / click-outside close), with every close affordance routed
 *  through the submitting-aware `requestClose` — Esc/backdrop must not unmount
 *  a mid-submit dialog (a later failure would be invisible). Enter is
 *  deliberately NOT wired to confirm — publishing is irreversible, so it takes
 *  an explicit click. */
export function CreatePRDialog({ open, task, onCreate, onClose }: CreatePRDialogProps) {
  const v = useCreatePrDialog({ open, task, onCreate, onClose });
  if (!open || task === null) return null;

  const branch = task.branch ?? `nc/${task.id}`;
  const baseLabel = v.base.trim().length > 0 ? v.base.trim() : 'the project base';

  return (
    <Modal
      label="Create pull request"
      panelClassName="w-full max-w-md overflow-hidden rounded-[14px] border border-border bg-popover shadow-2xl"
      onClose={v.requestClose}
    >
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">Create pull request</h2>
          <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <BranchIcon size={13} />
            <span className="truncate font-mono text-foreground">{branch}</span>
            <span aria-hidden>→</span>
            <span className="truncate font-mono text-foreground">{baseLabel}</span>
          </div>
        </div>
        <IconButton label="Close" onClick={v.requestClose} className="-mr-1 shrink-0">
          <CloseIcon size={16} />
        </IconButton>
      </div>

      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 pb-2">
        {v.drafting && (
          <div
            role="status"
            className="flex items-center gap-2 py-1 text-[13px] text-muted-foreground"
          >
            <Spinner />
            <span>Drafting title and body…</span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="pr-title" className={LABEL_CLASS}>
            Title
          </label>
          <input
            id="pr-title"
            type="text"
            value={v.title}
            onChange={(e) => v.setTitle(e.target.value)}
            placeholder="feat: what this change ships"
            disabled={v.submitting}
            className={INPUT_CLASS}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="pr-body" className={LABEL_CLASS}>
            Body
          </label>
          <textarea
            id="pr-body"
            value={v.body}
            onChange={(e) => v.setBody(e.target.value)}
            rows={6}
            placeholder="Summary and test plan…"
            disabled={v.submitting}
            className={`resize-none ${INPUT_CLASS}`}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>Base branch</span>
          <BranchPicker
            value={v.base}
            onChange={v.setBase}
            branches={v.branches}
            allowCreate={false}
            placeholder="Project base · default"
            ariaLabel="Base branch"
            disabled={v.submitting}
          />
          {v.staleDraftNote !== null && (
            <p className="text-[11px] leading-snug text-muted-foreground">{v.staleDraftNote}</p>
          )}
        </div>

        <Checkbox
          checked={v.draft}
          onChange={v.setDraft}
          label="Open as a draft pull request"
          disabled={v.submitting}
        />

        {v.error !== null && (
          <p className="rounded-[8px] border border-destructive/40 bg-destructive/[0.12] px-3 py-2 text-[12px] text-destructive">
            {v.error}
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-2.5 border-t border-border bg-black/15 px-5 py-3.5">
        <p className="text-[12px] leading-snug text-muted-foreground">
          push <span className="font-mono text-foreground">{branch}</span> to origin and open a
          pull request against <span className="font-mono text-foreground">{baseLabel}</span>
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={v.requestClose} disabled={v.submitting}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!v.canSubmit} onClick={v.submit}>
            {v.submitting ? (
              <>
                <Spinner />
                <span>Creating…</span>
              </>
            ) : (
              'Create PR'
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
