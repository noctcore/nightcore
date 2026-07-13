/** Bridge commands — Council (governed multi-agent debate, issue #352). Start / kill
 *  a run; the append-only transcript streams over `nc:debate` (see `onDebateEvent`).
 *  The canvas only READS that stream — there is no command that feeds text back into a
 *  seat prompt (the conductor-mediated, quoted, injection-scanned bus stays the sole
 *  cross-seat path — safety #1/#2). */
import { tauriInvoke } from '../internal';
import type { CouncilPresetId } from '../types';

/** Start a governed Council debate run over the active project. Unlike the scan
 *  `start-*` families — where Rust assigns the `runId` — the web MINTS it here and
 *  passes it: it is the `nc:debate` correlation key the canvas filters a run's stream
 *  by. `objective` is the task the seats debate; `projectPath` is the working directory
 *  the seat sessions run in (omit ⇒ the engine process cwd). Fire-and-forget: the run
 *  and its transcript live in the engine, streamed back over `nc:debate`. No-ops
 *  outside Tauri (browser preview). */
export async function startCouncil(
  runId: string,
  presetId: CouncilPresetId,
  objective: string,
  projectPath?: string | null,
): Promise<void> {
  await tauriInvoke<void>(
    'start_council',
    { runId, presetId, objective, projectPath: projectPath ?? null },
    undefined,
  );
}

/** Throw a running Council's kill switch (safety non-negotiable #4 — never "run until
 *  they agree"). Best-effort + idempotent: a no-op for an unknown/finished run, or when
 *  the sidecar isn't up. No-ops outside Tauri (browser preview). */
export async function killCouncil(runId: string): Promise<void> {
  await tauriInvoke<void>('kill_council', { runId }, undefined);
}
