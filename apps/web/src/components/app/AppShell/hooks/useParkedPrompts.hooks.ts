import { useCallback, useEffect, useState } from 'react';

import type { ToastApi } from '@/components/ui';
import {
  answerQuestion,
  onPermissionEvent,
  onQuestionEvent,
  type PermissionPrompt,
  type QuestionAnswer,
  type QuestionPrompt,
  respondPermission,
  type Task,
} from '@/lib/bridge';

/**
 * Shared machinery for a family of parked interactive prompts that block a live
 * run — permission approvals (`nc:permission`) and AskUserQuestion answers
 * (`nc:question`). It:
 *  - subscribes to the prompt channel and groups prompts by task id (dedup-guarded);
 *  - prunes prompts for tasks whose session is no longer live (kept for both
 *    `in_progress` AND `verifying`, since the reviewer subagent runs in-session and
 *    can park a dialog — pruning a still-live task would hang the engine dialog);
 *  - exposes `resolve(taskId, requestId, send)` that removes the prompt
 *    optimistically and re-inserts it (dedup-guarded) if `send` rejects, so the run
 *    never hangs on a prompt the UI already dropped.
 */
function useParkedPrompts<T extends { taskId: string; requestId: string }>(
  subscribe: (handler: (prompt: T) => void) => Promise<() => void>,
  tasks: Task[],
  toast: ToastApi,
  errorMessage: string,
): {
  prompts: Record<string, T[]>;
  resolve: (taskId: string, requestId: string, send: () => Promise<void>) => void;
} {
  const [prompts, setPrompts] = useState<Record<string, T[]>>({});

  useEffect(() => {
    const unlisten = subscribe((prompt) => {
      setPrompts((prev) => {
        const existing = prev[prompt.taskId] ?? [];
        if (existing.some((p) => p.requestId === prompt.requestId)) return prev;
        return { ...prev, [prompt.taskId]: [...existing, prompt] };
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [subscribe]);

  useEffect(() => {
    const live = new Set(
      tasks
        .filter((t) => t.status === 'in_progress' || t.status === 'verifying')
        .map((t) => t.id),
    );
    setPrompts((prev) => {
      const next: Record<string, T[]> = {};
      let changed = false;
      for (const [taskId, list] of Object.entries(prev)) {
        if (live.has(taskId)) next[taskId] = list;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tasks]);

  const resolve = useCallback(
    (taskId: string, requestId: string, send: () => Promise<void>) => {
      // Optimistically remove the prompt, capturing it so a failed relay can be
      // re-inserted — otherwise the run parks forever on a prompt already dropped.
      let removed: T | undefined;
      setPrompts((prev) => {
        const list = prev[taskId] ?? [];
        removed = list.find((p) => p.requestId === requestId);
        const remaining = list.filter((p) => p.requestId !== requestId);
        const next = { ...prev };
        if (remaining.length === 0) delete next[taskId];
        else next[taskId] = remaining;
        return next;
      });
      void send().catch((err) => {
        console.error(errorMessage, err);
        toast.error(errorMessage, err);
        if (removed === undefined) return;
        const prompt = removed;
        // Re-insert (dedup-guarded) so the user can retry rather than hang the run.
        setPrompts((prev) => {
          const list = prev[taskId] ?? [];
          if (list.some((p) => p.requestId === prompt.requestId)) return prev;
          return { ...prev, [taskId]: [...list, prompt] };
        });
      });
    },
    [toast, errorMessage],
  );

  return { prompts, resolve };
}

/** Parked interactive permission prompts (`nc:permission`). Answering removes the
 *  prompt optimistically (the backend resolves the parked request) and re-inserts
 *  it if the relay fails — see {@link useParkedPrompts}. */
export function usePermissions(tasks: Task[], toast: ToastApi) {
  const { prompts, resolve } = useParkedPrompts<PermissionPrompt>(
    onPermissionEvent,
    tasks,
    toast,
    'Could not answer the permission prompt',
  );
  const respond = useCallback(
    (taskId: string, requestId: string, decision: 'allow' | 'deny') => {
      resolve(taskId, requestId, () => respondPermission(taskId, requestId, decision));
    },
    [resolve],
  );
  return { prompts, respond };
}

/** Parked interactive `AskUserQuestion` prompts (`nc:question`). Answering removes
 *  the prompt optimistically (the engine settles the parked dialog) and re-inserts
 *  it if the relay fails — see {@link useParkedPrompts}. */
export function useQuestions(tasks: Task[], toast: ToastApi) {
  const { prompts, resolve } = useParkedPrompts<QuestionPrompt>(
    onQuestionEvent,
    tasks,
    toast,
    'Could not answer the question',
  );
  const answer = useCallback(
    (taskId: string, requestId: string, value: QuestionAnswer) => {
      resolve(taskId, requestId, () => answerQuestion(taskId, requestId, value));
    },
    [resolve],
  );
  return { prompts, answer };
}
