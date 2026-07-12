/** The convert-to-task confirmation dialog. Previews the board task that will be
 *  minted from the verdict — its title, the suggested kind (mirrors the Rust
 *  `task_kind_for`: complex feature → Decompose, else Build), and the complexity→effort
 *  sizing — and notes that the verdict is embedded as a warning-framed untrusted block
 *  with a `sourceRef` back to the validation. Idempotent: an already-linked validation
 *  shows "Go to task" instead of converting again. */
import {
  AlertIcon,
  Button,
  ConfirmHint,
  DecomposeIcon,
  Modal,
  MoveIcon,
  Spinner,
  useLastPresent,
} from '@/components/ui';

import type { ConvertToTaskDialogProps } from './ConvertToTaskDialog.types';

const PANEL =
  'w-full max-w-md overflow-hidden rounded-[14px] border border-border bg-popover shadow-2xl';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12.5px]">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 truncate text-foreground">{value}</span>
    </div>
  );
}

export function ConvertToTaskDialog({
  open,
  issueNumber,
  issueTitle,
  suggestedKind,
  complexityLabel,
  effortLabel,
  converting,
  alreadyLinked,
  error,
  onClose,
  onConvert,
  onGotoBoard,
}: ConvertToTaskDialogProps) {
  // Retain the display content across the exit animation so the panel doesn't blank.
  const shown =
    useLastPresent(
      open
        ? { issueNumber, issueTitle, suggestedKind, complexityLabel, effortLabel, alreadyLinked }
        : null,
    ) ?? { issueNumber, issueTitle, suggestedKind, complexityLabel, effortLabel, alreadyLinked };

  return (
    <Modal
      open={open}
      role="dialog"
      label="Convert validation to a board task"
      initialFocus="[data-cancel]"
      panelClassName={PANEL}
      onClose={onClose}
      onEnter={converting || shown.alreadyLinked ? undefined : onConvert}
    >
      <div className="flex flex-col gap-2 px-5 pb-3 pt-5">
        <h2 className="text-base font-semibold text-foreground">Convert to board task</h2>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {shown.alreadyLinked
            ? 'This validation is already linked to a board task.'
            : 'Creates a Backlog task from the verdict. The full analysis is embedded as a warning-framed untrusted block, and a source reference links the task back to this validation.'}
        </p>
      </div>

      <div className="mx-5 mb-3 flex flex-col gap-2 rounded-[10px] border border-border bg-white/[0.02] px-3.5 py-3">
        <Row
          label="Title"
          value={
            shown.issueNumber !== null ? `#${shown.issueNumber} · ${shown.issueTitle}` : shown.issueTitle
          }
        />
        <Row label="Kind" value={shown.suggestedKind} />
        {shown.complexityLabel !== null && (
          <Row
            label="Sizing"
            value={
              shown.effortLabel !== null
                ? `${shown.complexityLabel} → ${shown.effortLabel} effort`
                : shown.complexityLabel
            }
          />
        )}
        {shown.suggestedKind === 'Decompose' && (
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <DecomposeIcon size={12} />
            A complex feature — it lands as a Decompose task to break down first.
          </p>
        )}
      </div>

      {error !== null && (
        <div className="mx-5 mb-3 flex items-center gap-2 rounded-[10px] border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-[12.5px] text-destructive">
          <AlertIcon size={14} />
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        {shown.alreadyLinked ? (
          <>
            <Button data-cancel variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button data-confirm variant="primary" onClick={onGotoBoard}>
              <MoveIcon size={15} />
              Go to task
            </Button>
          </>
        ) : (
          <>
            <ConfirmHint>to create</ConfirmHint>
            <Button data-cancel variant="ghost" disabled={converting} onClick={onClose}>
              Cancel
            </Button>
            <Button
              data-confirm
              variant="primary"
              disabled={converting}
              aria-busy={converting}
              onClick={onConvert}
            >
              {converting ? <Spinner size={14} /> : <MoveIcon size={15} />}
              Create task
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
