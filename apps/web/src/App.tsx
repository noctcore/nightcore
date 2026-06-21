import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cancelTask,
  createTask,
  deleteTask,
  isTauri,
  listTasks,
  onSessionEvent,
  onTaskEvent,
  runTask,
  type Task,
} from './bridge';
import { EMPTY_STREAM, foldSession, type SessionStream } from './session-stream';
import { Board } from './components/Board';
import { NewTaskForm } from './components/NewTaskForm';
import { TaskDetail } from './components/TaskDetail';

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [streams, setStreams] = useState<Record<string, SessionStream>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  // Seed from persisted state.
  useEffect(() => {
    let active = true;
    void listTasks().then((seed) => {
      if (active) setTasks(seed);
    });
    return () => {
      active = false;
    };
  }, []);

  // Subscribe once to board upserts.
  useEffect(() => {
    const unlisten = onTaskEvent((task) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === task.id);
        if (idx === -1) return [...prev, task];
        const next = prev.slice();
        next[idx] = task;
        return next;
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Subscribe once to streamed session events; route into per-task buffers.
  useEffect(() => {
    const unlisten = onSessionEvent(({ taskId, event }) => {
      setStreams((prev) => {
        const current = prev[taskId] ?? EMPTY_STREAM;
        return { ...prev, [taskId]: foldSession(current, event) };
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const anyRunning = useMemo(
    () => tasks.some((t) => t.status === 'in_progress'),
    [tasks],
  );

  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  const handleCreate = useCallback(async (title: string, description: string) => {
    const task = await createTask(title, description);
    // The core also emits nc:task; upsert defensively in case it lands first.
    setTasks((prev) =>
      prev.some((t) => t.id === task.id) ? prev : [...prev, task],
    );
    setSelectedId(task.id);
  }, []);

  const handleRun = useCallback((id: string) => {
    // Fresh stream buffer for this run.
    setStreams((prev) => ({ ...prev, [id]: { ...EMPTY_STREAM } }));
    void runTask(id).catch((err) => {
      console.error('run_task failed', err);
    });
  }, []);

  const handleCancel = useCallback((id: string) => {
    void cancelTask(id).catch((err) => {
      console.error('cancel_task failed', err);
    });
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      void deleteTask(id).catch((err) => {
        console.error('delete_task failed', err);
      });
      setTasks((prev) => prev.filter((t) => t.id !== id));
      setStreams((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/60 px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold tracking-tight">Nightcore</span>
          <span className="text-xs text-zinc-500">
            {anyRunning ? 'running' : `${tasks.length} tasks`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowNewForm(true)}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
        >
          + New task
        </button>
      </header>

      {!isTauri() && (
        <p className="border-b border-amber-700/40 bg-amber-950/30 px-4 py-2 text-sm text-amber-300">
          Browser preview — run <code>bun run desktop</code> to drive the
          sidecar. Commands are no-ops here.
        </p>
      )}

      <main className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {tasks.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-zinc-500">No tasks yet.</p>
              <button
                type="button"
                onClick={() => setShowNewForm(true)}
                className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
              >
                Create your first task
              </button>
            </div>
          ) : (
            <Board
              tasks={tasks}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>

        {selected !== null && (
          <TaskDetail
            task={selected}
            stream={streams[selected.id]}
            anyRunning={anyRunning}
            onClose={() => setSelectedId(null)}
            onRun={handleRun}
            onCancel={handleCancel}
            onDelete={handleDelete}
          />
        )}
      </main>

      {showNewForm && (
        <NewTaskForm
          onCreate={handleCreate}
          onClose={() => setShowNewForm(false)}
        />
      )}
    </div>
  );
}
