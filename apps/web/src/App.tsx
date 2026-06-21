import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri, onNcEvent, startPrompt, type NcEvent } from './bridge';

interface ToolLine {
  id: number;
  toolName: string;
}

type Status = 'idle' | 'running' | 'completed' | 'failed';

interface RunState {
  status: Status;
  model: string | null;
  answer: string;
  tools: ToolLine[];
  costUsd: number | null;
  error: string | null;
}

const INITIAL: RunState = {
  status: 'idle',
  model: null,
  answer: '',
  tools: [],
  costUsd: null,
  error: null,
};

const STATUS_STYLE: Record<Status, string> = {
  idle: 'text-zinc-500',
  running: 'text-sky-400',
  completed: 'text-emerald-400',
  failed: 'text-rose-400',
};

export function App() {
  const [prompt, setPrompt] = useState('');
  const [run, setRun] = useState<RunState>(INITIAL);
  // Whether the active turn streamed partial deltas, so the final whole-message
  // block (partial: false) can be suppressed — mirrors the engine's own dedup.
  const streamedPartial = useRef(false);
  const toolSeq = useRef(0);

  useEffect(() => {
    const unlistenPromise = onNcEvent((event) => setRun((prev) => fold(prev, event)));
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const fold = useCallback((prev: RunState, event: NcEvent): RunState => {
    switch (event.type) {
      case 'session-started':
        streamedPartial.current = false;
        toolSeq.current = 0;
        return { ...INITIAL, status: 'running', model: event.model };
      case 'assistant-delta': {
        if (event.partial) {
          streamedPartial.current = true;
          return { ...prev, answer: prev.answer + event.text };
        }
        if (streamedPartial.current) return prev;
        return { ...prev, answer: prev.answer + event.text };
      }
      case 'tool-use-requested':
        streamedPartial.current = false;
        toolSeq.current += 1;
        return {
          ...prev,
          tools: [...prev.tools, { id: toolSeq.current, toolName: event.toolName }],
        };
      case 'session-completed':
        return { ...prev, status: 'completed', costUsd: event.costUsd };
      case 'session-failed':
        return {
          ...prev,
          status: 'failed',
          error: `${event.reason}: ${event.message}`,
        };
      default:
        return prev;
    }
  }, []);

  const submit = useCallback(() => {
    const text = prompt.trim();
    if (text.length === 0 || run.status === 'running') return;
    setRun({ ...INITIAL, status: 'running' });
    streamedPartial.current = false;
    void startPrompt(text);
  }, [prompt, run.status]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/60 px-4 py-2">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold tracking-tight">Nightcore</span>
          <span className="text-xs text-zinc-500">{run.model ?? 'idle'}</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className={STATUS_STYLE[run.status]}>{run.status}</span>
          {run.costUsd !== null && (
            <span className="text-zinc-500">${run.costUsd.toFixed(4)}</span>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 py-4">
        {!isTauri() && (
          <p className="mb-3 rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
            Browser preview — run <code>bun run desktop</code> to drive the
            sidecar.
          </p>
        )}
        {run.tools.length > 0 && (
          <ul className="mb-3 space-y-1">
            {run.tools.map((tool) => (
              <li key={tool.id} className="text-xs text-sky-400/80">
                ⚙ {tool.toolName}
              </li>
            ))}
          </ul>
        )}
        {run.error !== null ? (
          <pre className="whitespace-pre-wrap text-sm text-rose-400">
            {run.error}
          </pre>
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-zinc-100">
            {run.answer ||
              (run.status === 'running' ? '…' : 'Ask Nightcore anything.')}
          </pre>
        )}
      </main>

      <footer className="border-t border-zinc-800 bg-zinc-950/60 px-4 py-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="Describe a task…  (⌘/Ctrl+Enter to run)"
          className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={run.status === 'running' || prompt.trim().length === 0}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white enabled:hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {run.status === 'running' ? 'Running…' : 'Run'}
          </button>
        </div>
      </footer>
    </div>
  );
}
