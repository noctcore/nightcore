import { Kbd } from '@/components/ui';

import { useTaskOverviewEditor } from './TaskOverviewEditor.hooks';
import type { TaskOverviewEditorProps } from './TaskOverviewEditor.types';

const LABEL_CLASS = 'font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground';
const FIELD_CLASS =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';

/** The pre-run editable title + description block (T13). Shown in the drawer's Overview
 *  while a task is still editable (backlog/ready); the inputs are uncontrolled (seeded
 *  from the task, re-keyed per id) and commit on blur / Enter (⌘↵ for the description),
 *  matching the create dialog's submit idiom. Post-run the drawer renders the read-only
 *  Markdown description instead. */
export function TaskOverviewEditor(props: TaskOverviewEditorProps) {
  const { task } = props;
  const { commitTitle, commitDescription } = useTaskOverviewEditor(props);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="task-title-edit" className={LABEL_CLASS}>
          Title
        </label>
        <input
          id="task-title-edit"
          key={`title-${task.id}`}
          defaultValue={task.title}
          placeholder="Task title"
          className={FIELD_CLASS}
          onBlur={(e) => commitTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitTitle(e.currentTarget.value);
              e.currentTarget.blur();
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="task-description-edit" className={LABEL_CLASS}>
          Description
        </label>
        <textarea
          id="task-description-edit"
          key={`description-${task.id}`}
          defaultValue={task.description}
          rows={4}
          placeholder="Describe what you want built…"
          className={`resize-none ${FIELD_CLASS}`}
          onBlur={(e) => commitDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commitDescription(e.currentTarget.value);
              e.currentTarget.blur();
            }
          }}
        />
        <span className="flex items-center gap-1 text-2xs text-muted-foreground">
          <Kbd>⌘↵</Kbd> or blur to save
        </span>
      </div>
    </section>
  );
}
