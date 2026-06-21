import type { Task } from '../bridge';
import type { SessionStream } from '../session-stream';
import { formatCost, STATUS_LABEL, STATUS_TEXT } from '../status';
import { StatusDot } from './StatusDot';

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
    <aside className="flex h-full w-[28rem] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/80">
      <header className="flex items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-100">
            {task.title || 'Untitled task'}
          </h2>
          <div className="mt-1 flex items-center gap-1.5">
            <StatusDot status={task.status} />
            <span className={`text-xs ${STATUS_TEXT[task.status]}`}>
              {STATUS_LABEL[task.status]}
            </span>
            {cost !== null && (
              <span className="text-xs tabular-nums text-zinc-500">
                · {formatCost(cost)}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail panel"
          className="-mr-1 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          ✕
        </button>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-auto px-4 py-4">
        {task.description.trim().length > 0 && (
          <section>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Description
            </h3>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
              {task.description}
            </p>
          </section>
        )}

        {tools.length > 0 && (
          <section>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Tools
            </h3>
            <ul className="space-y-1">
              {tools.map((tool) => (
                <li key={tool.id} className="text-xs text-sky-400/80">
                  ⚙ {tool.toolName}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex-1">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            {isRunning ? 'Live output' : 'Output'}
          </h3>
          {error !== null ? (
            <pre className="whitespace-pre-wrap rounded-md border border-rose-900/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-300">
              {error}
            </pre>
          ) : answer.length > 0 ? (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-zinc-100">
              {answer}
              {isRunning && <span className="text-zinc-600">▌</span>}
            </pre>
          ) : (
            <p className="text-sm text-zinc-600">
              {isRunning ? 'Waiting for output…' : 'No output yet.'}
            </p>
          )}
        </section>
      </div>

      <footer className="flex items-center gap-2 border-t border-zinc-800 px-4 py-3">
        {isRunning ? (
          <button
            type="button"
            onClick={() => onCancel(task.id)}
            className="rounded-md bg-rose-600/90 px-4 py-1.5 text-sm font-medium text-white hover:bg-rose-600"
          >
            Cancel run
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onRun(task.id)}
            disabled={anyRunning}
            title={anyRunning ? 'Another task is already running' : undefined}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white enabled:hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Run
          </button>
        )}
        <span className="flex-1" />
        {!isRunning && (
          <button
            type="button"
            onClick={() => onDelete(task.id)}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-500 hover:text-rose-300"
          >
            Delete
          </button>
        )}
      </footer>
    </aside>
  );
}
