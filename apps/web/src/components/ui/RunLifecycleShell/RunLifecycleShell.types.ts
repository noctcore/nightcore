/** Public types for the RunLifecycleShell component. */
import type { ReactNode } from 'react';

/** The lifecycle screen a run view is currently showing. */
export type RunPhase = 'configure' | 'running' | 'results';

/** Props for the RunLifecycleShell component. */
export interface RunLifecycleShellProps {
  /** Left-aligned title (e.g. "Harness", "Insight"). */
  title: ReactNode;
  /** Optional sub-line under the title — typically the project name. */
  subtitle?: ReactNode;
  /** Which lifecycle screen is active; derives the frame's affordances. */
  phase: RunPhase;
  /**
   * The collapsed-config summary bar, rendered below the header whenever
   * `phase !== 'configure'` (e.g. `⌖ opus-4.8 · high · 8 lenses`). The view
   * owns its click-to-reconfigure behavior — the shell only renders the slot.
   */
  summary?: ReactNode;
  /** Right-aligned header actions slot (History, New run). */
  actions?: ReactNode;
  /** The active screen body; cross-fades on `phase` change. */
  children: ReactNode;
}
