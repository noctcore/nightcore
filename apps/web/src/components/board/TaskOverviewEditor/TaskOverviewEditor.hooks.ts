import { useCallback } from 'react';

import type { TaskOverviewEditorProps } from './TaskOverviewEditor.types';

/** Commit-on-blur/Enter handlers for the editable title/description. The inputs are
 *  uncontrolled (seeded from the task, re-keyed per task id), so the only logic here is
 *  the commit guard: a blank or unchanged title is a no-op (a task always keeps a title),
 *  and the description commits any change (including clearing it). Pure callbacks, so the
 *  editor holds no state of its own. */
export function useTaskOverviewEditor({
  task,
  onChangeTitle,
  onChangeDescription,
}: TaskOverviewEditorProps): {
  commitTitle: (raw: string) => void;
  commitDescription: (raw: string) => void;
} {
  const { id, title, description } = task;
  const commitTitle = useCallback(
    (raw: string) => {
      const next = raw.trim();
      if (next.length > 0 && next !== title) onChangeTitle(id, next);
    },
    [id, title, onChangeTitle],
  );
  const commitDescription = useCallback(
    (raw: string) => {
      if (raw !== description) onChangeDescription(id, raw);
    },
    [id, description, onChangeDescription],
  );
  return { commitTitle, commitDescription };
}
