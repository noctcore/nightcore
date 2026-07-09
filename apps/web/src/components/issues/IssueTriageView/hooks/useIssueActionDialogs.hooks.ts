/** The two human-gated action dialogs for a validated issue: post-as-GitHub-comment
 *  (with a server-rendered preview) and convert-to-task. Each removes optimistically
 *  and surfaces its own inline error/loading state. */
import { useCallback, useState } from 'react';

import type { ToastApi } from '@/components/ui';
import {
  postIssueValidationComment,
  previewIssueComment,
  type Task,
} from '@/lib/bridge';

import { errMessage } from '../IssueTriageView.utils';

export interface PostDialogState {
  open: boolean;
  body: string;
  loading: boolean;
  error: string | null;
  posting: boolean;
}

export interface ConvertDialogState {
  open: boolean;
  converting: boolean;
  error: string | null;
}

interface UseIssueActionDialogsArgs {
  /** The run backing the current panel verdict, or `null` when there's nothing to act on. */
  runId: string | null;
  /** Whether the panel currently holds a verdict result (gates opening the post dialog). */
  hasResult: boolean;
  /** Re-project a run so the panel picks up server-side markers (e.g. `postedAt`). */
  selectRun: (runId: string) => Promise<void>;
  /** Convert the run to a task (updates the stream's `linkedTaskId`). */
  convert: (runId: string) => Promise<Task>;
  toast: ToastApi;
}

export interface UseIssueActionDialogsResult {
  postDialog: PostDialogState;
  onOpenPostDialog: () => void;
  onClosePostDialog: () => void;
  onSubmitPost: () => void;
  convertDialog: ConvertDialogState;
  onOpenConvertDialog: () => void;
  onCloseConvertDialog: () => void;
  onSubmitConvert: () => void;
}

export function useIssueActionDialogs({
  runId,
  hasResult,
  selectRun,
  convert,
  toast,
}: UseIssueActionDialogsArgs): UseIssueActionDialogsResult {
  const [postDialog, setPostDialog] = useState<PostDialogState>({
    open: false,
    body: '',
    loading: false,
    error: null,
    posting: false,
  });
  const [convertDialog, setConvertDialog] = useState<ConvertDialogState>({
    open: false,
    converting: false,
    error: null,
  });

  const onOpenPostDialog = useCallback(async () => {
    if (runId === null || !hasResult) return;
    setPostDialog({ open: true, body: '', loading: true, error: null, posting: false });
    try {
      const body = await previewIssueComment(runId);
      setPostDialog((p) => ({ ...p, body, loading: false }));
    } catch (err) {
      setPostDialog((p) => ({ ...p, loading: false, error: errMessage(err) }));
    }
  }, [runId, hasResult]);

  const onSubmitPost = useCallback(async () => {
    if (runId === null) return;
    setPostDialog((p) => ({ ...p, posting: true, error: null }));
    try {
      await postIssueValidationComment(runId);
      // Re-project the run so the panel picks up the `postedAt` marker.
      await selectRun(runId);
      setPostDialog((p) => ({ ...p, open: false, posting: false }));
      toast.push({ tone: 'success', title: 'Comment posted to GitHub' });
    } catch (err) {
      setPostDialog((p) => ({ ...p, posting: false, error: errMessage(err) }));
    }
  }, [runId, selectRun, toast]);

  const onSubmitConvert = useCallback(async () => {
    if (runId === null) return;
    setConvertDialog((c) => ({ ...c, converting: true, error: null }));
    try {
      await convert(runId);
      setConvertDialog((c) => ({ ...c, open: false, converting: false }));
      toast.push({ tone: 'success', title: 'Task created from the validation' });
    } catch (err) {
      setConvertDialog((c) => ({ ...c, converting: false, error: errMessage(err) }));
    }
  }, [runId, convert, toast]);

  return {
    postDialog,
    onOpenPostDialog: () => void onOpenPostDialog(),
    onClosePostDialog: () => setPostDialog((p) => ({ ...p, open: false })),
    onSubmitPost: () => void onSubmitPost(),
    convertDialog,
    onOpenConvertDialog: () => setConvertDialog({ open: true, converting: false, error: null }),
    onCloseConvertDialog: () => setConvertDialog((c) => ({ ...c, open: false })),
    onSubmitConvert: () => void onSubmitConvert(),
  };
}
