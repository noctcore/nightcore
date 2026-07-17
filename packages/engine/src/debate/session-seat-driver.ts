/**
 * The production {@link SeatDriver} (issue #350): maps one seat turn onto a one-shot
 * provider session and collects its output.
 *
 * P1 deliberately keeps this SIMPLE (the design's "for now, dispatch to seats directly
 * via the existing session path"). A seat turn = one session started with the
 * Conductor-assembled prompt; the seat's answer is the session's terminal `result`
 * text. The robust broadcast collector — bounded concurrency, quorum, and per-seat
 * timeouts so a hung seat can't stall the board — is issue #351; this driver is its
 * simplest correct predecessor.
 *
 * Correlation is race-free WITHOUT the #351 collector because the backend's
 * {@link SeatSessionBackend.spawn} returns the session's monotonic id SYNCHRONOUSLY
 * (the engine assigns it before any await). The driver subscribes first, spawns to
 * learn the exact id, then folds only that id's events — so concurrent blind-Propose
 * turns never cross wires.
 *
 * Sandbox + governance posture (issue #354, safety non-negotiable #3): EVERY seat
 * session is spawned under {@link SEAT_SESSION_HARDENING} — the OS write sandbox
 * (`sandboxWrites`) + the read-only `plan` governance tier — reusing the existing
 * per-session confinement machinery (`resolveStartSessionParams` →
 * `providers/claude/sandbox.ts` Seatbelt + the SDK permission mode). The posture is
 * stamped HERE, unconditionally, so a seat can never be spawned ungoverned; the
 * injection firewall (mediated, quoted, scanned peer delivery) is enforced by the
 * Conductor.
 */
import type {
  AutonomyLevel,
  NightcoreEvent,
  TokenUsage,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { BUILD_WRITER_HARDENING } from './build-writer.js';
import type {
  SeatDriver,
  SeatTurnRequest,
  SeatTurnResult,
} from './conductor-types.js';

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningOutputTokens: 0,
};

/**
 * The per-seat OS sandbox + governance tier (safety non-negotiable #3). A debating
 * seat REASONS — it never types keystrokes (the design: "debate plans, it never types
 * keystrokes"), so it runs at the MOST restrictive posture that still lets it answer:
 *
 *  - `autonomy: 'plan'` — the read-only governance tier. The provider lowers it to the
 *    SDK `plan` permission mode, so a seat structurally cannot execute an edit/write
 *    tool (it can only read + reason). No human approves per-seat tool calls in a
 *    council, so `plan` (deny writes) is correct where `ask` (await approval) would hang.
 *  - `sandboxWrites: true` — OS-level write containment (Seatbelt) as the compensating
 *    control, closing the lexical gate's gaps (Bash redirects, symlinks). Fail-open on a
 *    host without `sandbox-exec` (a loud warning), where the `plan` tier still governs.
 *
 * Stamped onto EVERY seat spawn unconditionally (not a per-run knob) — the governed
 * posture is the whole point of a council seat, never opt-in.
 */
export const SEAT_SESSION_HARDENING: {
  readonly autonomy: AutonomyLevel;
  readonly sandboxWrites: boolean;
} = { autonomy: 'plan', sandboxWrites: true };

/** The parameters a seat turn starts its one-shot session with. `autonomy` +
 *  `sandboxWrites` are the per-seat governance tier + OS sandbox (safety #3), stamped
 *  by the driver from {@link SEAT_SESSION_HARDENING} — required, so the backend wiring
 *  MUST forward them onto the underlying `start-session` command. */
export interface SeatSessionParams {
  readonly prompt: string;
  readonly model: string;
  readonly cwd?: string;
  /** The seat's governance tier (safety #3) — the read-only `plan` mode. */
  readonly autonomy: AutonomyLevel;
  /** The seat's OS write sandbox (safety #3) — Seatbelt write containment. */
  readonly sandboxWrites: boolean;
}

/**
 * The narrow engine seam this driver needs — a subset of the {@link
 * import('../session/session-manager.js').SessionManager} surface. Injecting it (not
 * the whole supervisor) keeps the driver unit-testable with a fake backend.
 */
export interface SeatSessionBackend {
  /** Start a one-shot session for a seat turn and return its monotonic session id
   *  SYNCHRONOUSLY (assigned before any await), so events can be correlated race-free. */
  spawn(params: SeatSessionParams): number;
  /** Subscribe to the engine event stream; returns an unsubscribe fn. */
  on(listener: (event: NightcoreEvent) => void): () => void;
  /** Cancel a seat's underlying provider session by id (PR #359 LOW-B): on
   *  timeout/quorum/kill the driver asks the backend to STOP the session so an
   *  abandoned seat can't keep spending provider-side. Best-effort + optional (a fake
   *  backend may omit it); a throw here never turns an abort into a rejection. */
  cancel?(sessionId: number): void;
}

export interface SessionSeatDriverDeps {
  readonly backend: SeatSessionBackend;
  readonly logger?: Logger;
}

export class SessionSeatDriver implements SeatDriver {
  constructor(private readonly deps: SessionSeatDriverDeps) {}

  /**
   * Run one DEBATING seat turn: spawn a session for `prompt` under {@link
   * SEAT_SESSION_HARDENING} (read-only `plan` tier + OS sandbox, safety #3), then resolve
   * on that session's terminal event. A `session-completed` yields the seat's `result` +
   * spend; a `session-failed` (or an abort) degrades to an EMPTY turn (zero content + zero
   * spend) so one broken seat never rejects the whole council — the debate proceeds with
   * the remaining positions. This is the ONLY posture a debating seat ever runs at.
   */
  runTurn(request: SeatTurnRequest): Promise<SeatTurnResult> {
    return this.collectSession(request, SEAT_SESSION_HARDENING);
  }

  /**
   * Run the SINGLE elected writer's Build turn (issue #383, safety #5 + #3) — the ONE
   * write-capable session in a whole council. It reuses the EXACT same spawn/correlate/
   * teardown machinery as {@link runTurn} (never a second session-spawn path), but stamps
   * {@link BUILD_WRITER_HARDENING} (`auto-accept` — write-capable, prompt suppressed — with
   * the OS write sandbox STILL on, deliberately NOT `bypass`) and runs with `request.cwd`
   * = the elected writer's ISOLATED worktree. Everything else — the PreToolUse
   * workspace-confinement gate (auto-scoped to that cwd), `platform::git_command`
   * isolation, the Seatbelt sandbox — is enforced by the existing per-session confinement
   * chokepoints from that posture + cwd, so no new exec sink is introduced. Only the
   * Council `SessionBuildDriver` (for the conductor-elected writer) ever calls this; every
   * debating seat stays on {@link runTurn}'s read-only `plan` posture (safety #5).
   */
  runWriterTurn(request: SeatTurnRequest): Promise<SeatTurnResult> {
    return this.collectSession(request, BUILD_WRITER_HARDENING);
  }

  /**
   * The shared spawn → correlate → collect core behind {@link runTurn} (read-only) and
   * {@link runWriterTurn} (write-capable). Stamps `hardening` (the ONLY difference between
   * a debating seat and the elected writer) onto the spawn and folds ONLY the correlated
   * session's terminal event. Kept private so the write-capable posture can never be
   * requested without going through the two named entry points above.
   */
  private collectSession(
    request: SeatTurnRequest,
    hardening: { readonly autonomy: AutonomyLevel; readonly sandboxWrites: boolean },
  ): Promise<SeatTurnResult> {
    if (request.signal.aborted) return Promise.resolve(this.empty());

    return new Promise<SeatTurnResult>((resolve) => {
      // Filled by `spawn` below (synchronously, before any async event), so the
      // listener — which only fires later — always sees the correlated id. A holder
      // (not a bare `let`) keeps it a const the closure closes over.
      const correlation: { sessionId?: number } = {};
      let settled = false;
      let unsubscribe = (): void => {};

      const finish = (result: SeatTurnResult): void => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener('abort', onAbort);
        unsubscribe();
        resolve(result);
      };

      const onAbort = (): void => {
        this.deps.logger?.debug('seat turn aborted before completion', {
          seatId: request.seat.seatId,
        });
        // Cancel the underlying provider session so an abandoned seat (timed out,
        // superseded by quorum, or killed) stops spending provider-side (PR #359
        // LOW-B). Only when a session was actually spawned; best-effort — a missing
        // cancel seam or a throw must never turn the abort into a rejection.
        const sessionId = correlation.sessionId;
        if (sessionId !== undefined) {
          try {
            this.deps.backend.cancel?.(sessionId);
          } catch (error) {
            this.deps.logger?.debug('seat session cancel failed', {
              seatId: request.seat.seatId,
              sessionId,
              error,
            });
          }
        }
        finish(this.empty());
      };
      request.signal.addEventListener('abort', onAbort, { once: true });

      // Subscribe + spawn under a guard: if EITHER throws synchronously (an unexpected
      // hard error, not one of the two refusals converted upstream), tear the turn down
      // on that exit path too — `finish` removes the abort listener AND unsubscribes —
      // and degrade to an EMPTY turn instead of leaking a live listener while the run
      // fails (issue #351, LOW-B). Without this, a synchronous `spawn`/`on` throw
      // rejected the executor with the subscription still registered.
      try {
        // Subscribe BEFORE spawning so a fast terminal event is never missed. Only the
        // two terminal, session-scoped events matter — narrow first so `sessionId` is
        // known to exist (query-result events carry no session id).
        unsubscribe = this.deps.backend.on((event) => {
          if (
            event.type !== 'session-completed' &&
            event.type !== 'session-failed'
          ) {
            return;
          }
          if (
            correlation.sessionId === undefined ||
            event.sessionId !== correlation.sessionId
          ) {
            return;
          }
          if (event.type === 'session-completed') {
            finish({
              content: event.result,
              usage: event.usage ?? ZERO_USAGE,
              costUsd: event.costUsd ?? 0,
            });
          } else {
            this.deps.logger?.warn(
              'seat session failed; contributing an empty turn',
              { seatId: request.seat.seatId, reason: event.reason },
            );
            finish(this.empty());
          }
        });

        correlation.sessionId = this.deps.backend.spawn({
          prompt: request.prompt,
          model: request.seat.model,
          // Safety #3: the session is spawned OS-sandboxed + governed — a debating seat
          // at the read-only `plan` tier (SEAT_SESSION_HARDENING), the single elected
          // writer at the write-capable-but-sandboxed `auto-accept` tier
          // (BUILD_WRITER_HARDENING). Stamped here from the caller-selected posture so a
          // session can never run ungoverned, and the write-capable posture is reachable
          // ONLY through `runWriterTurn`.
          ...hardening,
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        });
      } catch (error) {
        this.deps.logger?.warn(
          'seat session spawn threw; tearing down and contributing an empty turn',
          { seatId: request.seat.seatId, error },
        );
        finish(this.empty());
      }
    });
  }

  private empty(): SeatTurnResult {
    return { content: '', usage: ZERO_USAGE, costUsd: 0 };
  }
}
