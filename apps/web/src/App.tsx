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
} from '@/lib/bridge';
import {
  Board,
  EMPTY_STREAM,
  foldSession,
  NewTaskForm,
  TaskDetail,
  type SessionStream,
} from '@/components/board';
import { Button, EmptyState } from '@/components/ui';

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

  const handleDelete = useCallback((id: string) => {
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
  }, []);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-popover px-5 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight">
            nightcore<span className="text-primary">.</span>
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {anyRunning ? 'running' : `${tasks.length} tasks`}
          </span>
        </div>
        <Button onClick={() => setShowNewForm(true)}>+ New task</Button>
      </header>

      {!isTauri() && (
        <p className="border-b border-warning/40 bg-warning/[0.12] px-5 py-2 text-sm text-warning">
          Browser preview — run <code className="font-mono">bun run desktop</code>{' '}
          to drive the sidecar. Commands are no-ops here.
        </p>
      )}

      <main className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {tasks.length === 0 ? (
            <EmptyState
              icon="📥"
              title="No tasks yet"
              description="Describe what you want built. Each task becomes a card an agent can pick up and run."
              action={
                <Button onClick={() => setShowNewForm(true)}>
                  Create your first task
                </Button>
              }
            />
          ) : (
            <Board tasks={tasks} selectedId={selectedId} onSelect={setSelectedId} />
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
