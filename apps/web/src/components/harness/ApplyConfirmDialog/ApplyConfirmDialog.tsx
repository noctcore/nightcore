import { Button, Kbd, Modal, Spinner } from '@/components/ui';

import { ARTIFACT_KIND_META, WRITE_MODE_META } from '../harness.constants';
import type { ApplyConfirmDialogProps } from './ApplyConfirmDialog.types';

/** Friendly, actionable explanation for the one apply failure users will actually
 *  hit: a `create` artifact whose target already exists. The Rust apply opens with
 *  `O_EXCL` and refuses (never overwrites), surfacing an "already exists" error —
 *  we translate that into plain language instead of a raw `std::io` string. */
function explainApplyError(error: string): string {
  if (/already exists/i.test(error)) {
    return "This file already exists — Nightcore won't overwrite it. Review and replace it manually, or dismiss.";
  }
  return error;
}

/** The pre-write confirmation for applying a harness artifact to disk. Built on
 *  the shared `<Modal>` and matched to the `ConfirmDialog` sibling convention: Esc
 *  / click-outside cancel, Enter confirms (the Apply button takes initial focus via
 *  `[data-confirm]`), and the `↵ to confirm` Kbd hint sits at the footer's left.
 *
 *  Beyond ConfirmDialog it adds the write-specific chrome: the confirm is disabled
 *  while the write is in flight (so it can't double-fire), and any error the Rust
 *  `apply_harness_artifact` returns (e.g. "file already exists — refusing to
 *  overwrite") is surfaced inline rather than swallowed. Enter is inert while
 *  applying so a held key can't re-trigger the write. */
export function ApplyConfirmDialog({
  artifact,
  applying,
  error,
  onConfirm,
  onCancel,
}: ApplyConfirmDialogProps) {
  const mode = WRITE_MODE_META[artifact.writeMode];
  const isCreate = artifact.writeMode === 'create';

  return (
    <Modal
      role="alertdialog"
      label={`Apply ${artifact.title}`}
      initialFocus="[data-confirm]"
      onClose={onCancel}
      onEnter={applying ? undefined : onConfirm}
    >
      <div className="flex flex-col gap-3 px-5 pb-4 pt-5">
        <h2 className="text-base font-semibold text-foreground">Apply this artifact?</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Write{' '}
          <code className="break-all rounded border border-border bg-white/[0.04] px-1 py-0.5 font-mono text-[12px] text-foreground">
            {artifact.targetPath}
          </code>{' '}
          (
          <span className="font-mono text-foreground">{mode?.label ?? artifact.writeMode}</span>
          {mode !== undefined ? ` — ${mode.hint}` : ''}) into the project.
        </p>
        <p className="text-[12px] text-muted-foreground">
          {ARTIFACT_KIND_META[artifact.kind].label} · {artifact.title}
        </p>
        {isCreate && (
          <p className="rounded-md border border-border bg-white/[0.02] px-3 py-2 text-[12px] text-muted-foreground">
            Creates a <span className="font-medium text-foreground">new file</span>. If a
            file already exists at this path, the apply is refused (never overwritten) —
            replace it manually instead.
          </p>
        )}
        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/[0.1] px-3 py-2 text-[12.5px] text-destructive"
          >
            {explainApplyError(error)}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>↵</Kbd> to confirm
        </span>
        <Button variant="ghost" disabled={applying} onClick={onCancel}>
          Cancel
        </Button>
        <Button data-confirm disabled={applying} aria-busy={applying} onClick={onConfirm}>
          {applying ? <Spinner /> : null}
          {applying ? 'Applying…' : 'Apply'}
        </Button>
      </div>
    </Modal>
  );
}
