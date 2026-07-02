/** State + effects for the Create PR dialog: the editable draft (title / body /
 *  base / draft-flag), the `draftPrMessage` pre-fill, the branch list for the
 *  base picker, and the single-flight submit with inline error. All state lives
 *  here so the `.tsx` shell stays a thin presentation layer. */
import { useCallback, useEffect, useState } from 'react';

import type { BranchInfo, CreatePrOptions, Task } from '@/lib/bridge';
import { draftPrMessage, listBranches } from '@/lib/bridge';

/** Everything the CreatePRDialog shell renders from. */
export interface CreatePrDialogView {
  /** Editable PR title, pre-filled by the drafter. */
  title: string;
  setTitle: (title: string) => void;
  /** Editable PR body (markdown), pre-filled by the drafter. */
  body: string;
  setBody: (body: string) => void;
  /** The base branch the PR targets (`''` ⇒ backend default, like merge). */
  base: string;
  setBase: (base: string) => void;
  /** Open the PR as a draft. Defaults off. */
  draft: boolean;
  setDraft: (draft: boolean) => void;
  /** The project's branches for the base picker (`[]` ⇒ free-form entry). */
  branches: BranchInfo[];
  /** True while `draftPrMessage` is pre-filling the title/body. */
  drafting: boolean;
  /** True while the create is in flight (single-flight guard). */
  submitting: boolean;
  /** Inline error from a failed create; the dialog stays open for a retry. */
  error: string | null;
  /** Whether Create may fire: a non-empty title, not drafting, not in flight. */
  canSubmit: boolean;
  /** Fire the create; no-ops while drafting/submitting or without a title. */
  submit: () => void;
}

/** Coerce a thrown value (Tauri rejections are commonly plain strings) into a
 *  readable inline-error line. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Orchestrate the Create PR dialog. On every open (or task switch while open)
 *  the fields reset and `draftPrMessage` pre-fills the title/body — a drafting
 *  failure (or the empty browser-preview fallback) degrades to the task's own
 *  title/description and never blocks the dialog. Submit is single-flight; a
 *  rejected create surfaces inline and keeps the dialog open. */
export function useCreatePrDialog({
  open,
  task,
  onCreate,
  onClose,
}: {
  open: boolean;
  task: Task | null;
  onCreate: (id: string, opts: CreatePrOptions) => Promise<void>;
  onClose: () => void;
}): CreatePrDialogView {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskId = task?.id ?? null;
  // Primitive fallbacks (not the task object) keep the pre-fill effect's deps
  // stable across `nc:task` echoes — only a real title/description edit refires.
  const fallbackTitle = task?.title ?? '';
  const fallbackBody = task?.description ?? '';
  const defaultBase = task?.baseBranch ?? '';

  // Reset + pre-fill on open (or when the dialog switches task while open). A
  // stale guard drops a late resolve after close/switch, mirroring the
  // WorktreeView preview fetch discipline.
  useEffect(() => {
    if (!open || taskId === null) return;
    setError(null);
    setDraft(false);
    setBase(defaultBase);
    setTitle('');
    setBody('');
    setDrafting(true);
    let stale = false;
    void draftPrMessage(taskId)
      .then((d) => {
        if (stale) return;
        // An empty drafted title (the outside-Tauri fallback) degrades to the
        // task's own title/description — the same fallback the command uses.
        const usable = d.title.trim().length > 0;
        setTitle(usable ? d.title : fallbackTitle);
        setBody(usable ? d.body : fallbackBody);
      })
      .catch(() => {
        if (stale) return;
        setTitle(fallbackTitle);
        setBody(fallbackBody);
      })
      .finally(() => {
        if (!stale) setDrafting(false);
      });
    return () => {
      stale = true;
    };
  }, [open, taskId, fallbackTitle, fallbackBody, defaultBase]);

  // Load the branch list for the base picker on open. Returns [] outside Tauri;
  // a failure just leaves free-form entry. When no base was chosen at create
  // time, default to the repo's checked-out branch (the merge default).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listBranches()
      .then((b) => {
        if (!alive) return;
        setBranches(b);
        setBase((prev) => (prev === '' ? (b.find((x) => x.isCurrent)?.name ?? '') : prev));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  const canSubmit = !submitting && !drafting && title.trim().length > 0;

  const submit = useCallback(() => {
    if (taskId === null || submitting || drafting) return;
    const finalTitle = title.trim();
    if (finalTitle.length === 0) return;
    setSubmitting(true);
    setError(null);
    const trimmedBase = base.trim();
    void Promise.resolve(
      onCreate(taskId, {
        base: trimmedBase.length > 0 ? trimmedBase : undefined,
        title: finalTitle,
        body,
        draft,
      }),
    )
      .then(() => onClose())
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setSubmitting(false));
  }, [taskId, submitting, drafting, title, body, base, draft, onCreate, onClose]);

  return {
    title,
    setTitle,
    body,
    setBody,
    base,
    setBase,
    draft,
    setDraft,
    branches,
    drafting,
    submitting,
    error,
    canSubmit,
    submit,
  };
}
