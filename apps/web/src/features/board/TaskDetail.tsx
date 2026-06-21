import type { Task } from '../../bridge';
import { Button, IconButton } from '../../shared/ui';
import type { SessionStream } from './session-stream';
import { formatCost, STATUS_LABEL, STATUS_TEXT } from './status';
import { TaskStatusDot } from './TaskStatusDot';

interface TaskDetailProps {
  task: Task;
  stream: SessionStream | undefined;
  /** True when ANY task is in_progress (serial-run guard). */
  anyRunning: boolean;
  onClose: () => void;
  onRun: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}

/** The logs / detail drawer — title, status, transcript, and run controls. */
export function TaskDetail({
  task,
  stream,
  anyRunning,
  onClose,
  onRun,
  onCancel,
  onDelete,
}: TaskDetailProps) {
  const isRunning = task.status === 'in_progress';
  // Live cost (from the stream) wins while running; otherwise the persisted cost.
  const cost = stream?.costUsd ?? task.costUsd;
  const error = stream?.error ?? task.error;
  const answer = stream?.answer ?? task.summary ?? '';
  const tools = stream?.tools ?? [];

  return (
    <aside className="nc-drawer-enter flex h-full w-[28rem] shrink-0 flex-col border-l border-border bg-popover">
      <header className="flex items-start justify-between gap-3 border-b border-border bg-card px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <TaskStatusDot status={task.status} glow />
            <span
              className={`font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${STATUS_TEXT[task.status]}`}
            >
              {STATUS_LABEL[task.status]}
            </span>
            {cost !== null && (
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                · {formatCost(cost)}
              </span>
            )}
          </div>
          <h2 className="mt-2 truncate text-base font-semibold text-foreground">
            {task.title || 'Untitled task'}
          </h2>
        </div>
        <IconButton label="Close detail panel" onClick={onClose}>
          ✕
        </IconButton>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-auto px-4 py-4">
        {task.description.trim().length > 0 && (
          <section>
            <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Description
            </h3>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {task.description}
            </p>
          </section>
        )}

        {tools.length > 0 && (
          <section>
            <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Tools
            </h3>
            <ul className="space-y-1">
              {tools.map((tool) => (
                <li key={tool.id} className="font-mono text-xs text-primary/80">
                  ⚙ {tool.toolName}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex-1">
          <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
            {isRunning ? 'Live transcript' : 'Transcript'}
          </h3>
          {error !== null ? (
            <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/[0.12] px-3 py-2 font-mono text-xs text-destructive">
              {error}
            </pre>
          ) : answer.length > 0 ? (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">
              {answer}
              {isRunning && <span className="text-muted-foreground">▌</span>}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {isRunning
                ? 'Waiting for first token…'
                : 'No output yet — run this task to stream its transcript.'}
            </p>
          )}
        </section>
      </div>

      <footer className="flex items-center gap-2 border-t border-border bg-card px-4 py-3">
        {isRunning ? (
          <Button variant="danger" onClick={() => onCancel(task.id)}>
            Cancel run
          </Button>
        ) : (
          <Button
            onClick={() => onRun(task.id)}
            disabled={anyRunning}
            title={anyRunning ? 'Another task is already running' : undefined}
          >
            Run
          </Button>
        )}
        <span className="flex-1" />
        {!isRunning && (
          <Button variant="ghost" onClick={() => onDelete(task.id)}>
            Delete
          </Button>
        )}
      </footer>
    </aside>
  );
}
