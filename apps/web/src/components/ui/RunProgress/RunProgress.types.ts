import type { ComponentType } from 'react';

/** The run's lifecycle status (mirrors `stream.status`). */
export type RunProgressStatus = 'idle' | 'running' | 'completed' | 'failed';

/** Per-category run state within a single run. */
export type CategoryRunState = 'pending' | 'running' | 'done' | 'error';

export interface RunProgressCategory {
  /** Stable key used to index every `Record` prop and passed to `onOpenCategory`. */
  key: string;
  /** Human-readable label shown in the row. */
  label: string;
  /** Leading glyph — a lucide icon component from `components/ui/icons`. Tinted
   *  at the call site, so it accepts an optional `className`. */
  icon: ComponentType<{ size?: number; className?: string }>;
}

export interface RunProgressUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunProgressProps {
  /** The run's lifecycle status; drives the live-elapsed ticker and the header dot. */
  status: RunProgressStatus;
  /** Every requested category, in display order — rendered as rows from the first scan-started. */
  categories: RunProgressCategory[];
  /** Per-category run state. Missing keys are treated as `pending`. */
  categoryState: Record<string, CategoryRunState>;
  /** Per-category finding count, shown on `done` rows. Missing keys count as `0`. */
  findingCounts: Record<string, number>;
  /** Noun for the overall count readout (`{finished} / {total} {unitLabel}`).
   *  Defaults to `lenses`; Insight passes `categories`. */
  unitLabel?: string;
  /** Harness only: show the synthesis row and an indeterminate bar shimmer. */
  synthesizing?: boolean;
  /** Cumulative run cost in USD. */
  costUsd: number;
  /** Cumulative token usage. */
  usage: RunProgressUsage;
  /** Backend-reported elapsed (ms); the live ticker advances past it while `running`. */
  durationMs: number;
  /** Fired when a `done`/`error` row is activated → partial reveal of that category. */
  onOpenCategory?: (key: string) => void;
}
