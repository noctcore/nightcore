import type { ReactNode } from 'react';
import type { TaskStatus } from '@nightcore/contracts';
import type { TaskView } from '../types.js';

interface TaskPanelProps {
  tasks: Map<string, TaskView>;
}

/** Status glyph + color per task state. `running` uses a half-circle as a static
 *  "in progress" mark (the renderer has no per-frame spinner here). */
const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: '○',
  running: '◐',
  completed: '✓',
  failed: '✗',
  killed: '⊘',
  paused: '‖',
};

const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: '#777777',
  running: '#5fafff',
  completed: '#5faf5f',
  failed: '#ff5f5f',
  killed: '#ff875f',
  paused: '#d7af00',
};

function TaskRow({ task }: { task: TaskView }): ReactNode {
  const glyphColor = STATUS_COLOR[task.status];
  // Ambient tasks are dimmed so foreground work stands out.
  const textColor = task.ambient ? '#777777' : '#cfd8e3';
  const label =
    task.description.length > 0 ? task.description : `task ${task.taskId}`;
  return (
    <text>
      <span fg={glyphColor}>{STATUS_GLYPH[task.status]} </span>
      <span fg={textColor}>{label}</span>
      {task.subagentType !== undefined && (
        <span fg="#9c6fff"> [{task.subagentType}]</span>
      )}
      {task.summary !== undefined && task.summary.length > 0 && (
        <span fg="#777777"> — {task.summary}</span>
      )}
    </text>
  );
}

/**
 * Compact live checklist of the session's tasks, keyed by `taskId`. Rendered
 * between the transcript and the input ONLY when there are non-ambient tasks; an
 * all-ambient or empty set collapses to nothing (App gates on this). Ambient
 * tasks still appear here, dimmed, so housekeeping is visible without cluttering
 * the inline transcript.
 */
export function TaskPanel({ tasks }: TaskPanelProps): ReactNode {
  const rows = [...tasks.values()];
  if (rows.length === 0) return null;
  return (
    <box
      title="tasks"
      style={{
        border: true,
        borderColor: '#3a3a4a',
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      {rows.map((task) => (
        <TaskRow key={task.taskId} task={task} />
      ))}
    </box>
  );
}

/** True when the panel has at least one non-ambient task worth showing. App uses
 *  this to decide whether to mount the panel at all (keeps the layout clean when
 *  only ambient housekeeping is in flight). */
export function hasVisibleTasks(tasks: Map<string, TaskView>): boolean {
  for (const task of tasks.values()) {
    if (!task.ambient) return true;
  }
  return false;
}
