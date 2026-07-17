/**
 * The engine end of the path-less, `councilRunId`-keyed worktree RPC (issue #383) — the
 * ONE new cross-process seam the write-capable Council reaches Rust's already-audited
 * `crate::worktree` + Structure-Lock gauntlet through. The engine (Bun sidecar) and
 * `crate::worktree` (Rust host) are DIFFERENT PROCESSES over NDJSON; this broker is the
 * engine-side correlation registry that lets an in-engine caller (the {@link
 * import('./session-build-driver.js').SessionBuildDriver} or the Converge gauntlet
 * runner) issue a worktree op and await its host-performed result.
 *
 * It is modeled EXACTLY on the parked-permission seam (`permission-required` → host acts →
 * resolving `approve-permission`) and the SDK question layer's `Map<requestId, resolver>`:
 *
 *  - {@link WorktreeOpBroker.request} mints a `requestId`, registers a pending resolver,
 *    emits ONE `worktree-op-required { requestId, op, councilRunId }` event onto the
 *    supervisor's event stream (the same sink `debate-entry` rides), and returns a Promise.
 *  - The Rust reader handles the event, performs the op against a worktree path it DERIVES
 *    from `councilRunId` (never an engine-sent path — the escape guard, path.rs), and
 *    dispatches a `resolve-worktree-op` command; the `CouncilRouter` routes it to {@link
 *    WorktreeOpBroker.resolve}, which settles the awaiting Promise.
 *
 * Security note (why this is a MESSAGE TYPE, not a write/exec sink): the request carries
 * NO path — only the closed `op` verb + the `councilRunId`. The host is the sole authority
 * over WHERE anything happens (`.nightcore/worktrees/<runId>`), so an injection-compromised
 * engine can name a verb + a run id but can never redirect a worktree op outside the run's
 * own isolated worktree.
 */
import type { NightcoreEvent, WorktreeOpKind } from '@nightcore/contracts';
import { createRequestIdFactory, type Logger } from '@nightcore/shared';

/**
 * What the Rust host reports back for a worktree op. The fields are per-op (mirroring the
 * `resolve-worktree-op` command): `worktreePath` for `allocate`; `gauntletPassed` +
 * `gauntletSummary` for `gauntlet`; a present `error` marks ANY op that could not run
 * (the caller fails CLOSED on it). `commit` success carries none of them.
 */
export interface WorktreeOpReply {
  readonly worktreePath?: string;
  readonly gauntletPassed?: boolean;
  readonly gauntletSummary?: string;
  readonly error?: string;
}

/** The default upper bound (ms) a request waits for its host reply before failing closed.
 *  Generous because a `gauntlet` op runs the whole Structure-Lock over the worktree (each
 *  check is itself bounded host-side); `allocate`/`commit` reply in well under a second. A
 *  kill/budget abort settles a request immediately regardless of this cap. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

export interface WorktreeOpBrokerDeps {
  /** Emit a `NightcoreEvent` onto the supervisor's event stream — the SAME sink the
   *  `nc:debate` transcript rides, so `worktree-op-required` reaches the Rust reader. */
  readonly emit: (event: NightcoreEvent) => void;
  /** Upper bound (ms) a request waits for its reply. Default {@link
   *  DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number;
  readonly logger?: Logger;
}

export class WorktreeOpBroker {
  private readonly pending = new Map<string, (reply: WorktreeOpReply) => void>();
  private readonly nextRequestId = createRequestIdFactory('wt');
  private readonly emit: (event: NightcoreEvent) => void;
  private readonly requestTimeoutMs: number;
  private readonly logger?: Logger;

  constructor(deps: WorktreeOpBrokerDeps) {
    this.emit = deps.emit;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (deps.logger !== undefined) this.logger = deps.logger;
  }

  /**
   * Issue one worktree op and await the host's result. Emits a single
   * `worktree-op-required` event correlated by a fresh `requestId`, then resolves when the
   * matching `resolve-worktree-op` command arrives. NEVER rejects: a kill/budget abort or a
   * reply timeout settles the Promise with an `{ error }` reply so the caller fails CLOSED
   * (an allocation that never came is a red build; a gauntlet that never ran is a red gate),
   * exactly as a broken seat degrades to an empty turn — one op can't crash the run.
   */
  request(
    op: WorktreeOpKind,
    councilRunId: string,
    signal: AbortSignal,
  ): Promise<WorktreeOpReply> {
    const requestId = this.nextRequestId();
    return new Promise<WorktreeOpReply>((resolve) => {
      let settled = false;
      // A holder (not a bare `let`) so the const closes over it while `settle` — defined
      // before the timer is armed — can still clear it.
      const timer: { id?: ReturnType<typeof setTimeout> } = {};

      const settle = (reply: WorktreeOpReply): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(requestId);
        signal.removeEventListener('abort', onAbort);
        if (timer.id !== undefined) clearTimeout(timer.id);
        resolve(reply);
      };

      const onAbort = (): void => {
        this.logger?.debug('worktree op aborted before the host replied', {
          op,
          councilRunId,
          requestId,
        });
        settle({ error: 'the run was killed or hit a budget cap before the worktree op completed' });
      };

      if (signal.aborted) {
        resolve({ error: 'the run was already halted before the worktree op could start' });
        return;
      }

      this.pending.set(requestId, settle);
      signal.addEventListener('abort', onAbort, { once: true });
      timer.id = setTimeout(() => {
        this.logger?.warn('worktree op timed out waiting for the host reply', {
          op,
          councilRunId,
          requestId,
        });
        settle({ error: `worktree op "${op}" timed out waiting for the host` });
      }, this.requestTimeoutMs);

      // Emit LAST — after the resolver is registered — so a fast host reply can never
      // arrive before the pending entry exists.
      try {
        this.emit({ type: 'worktree-op-required', requestId, op, councilRunId });
      } catch (error) {
        this.logger?.warn('failed to emit a worktree-op-required event', {
          op,
          councilRunId,
          requestId,
          error,
        });
        settle({ error: 'the engine could not reach the host to perform the worktree op' });
      }
    });
  }

  /**
   * Resolve a pending request with the host's reply (dispatched from the `CouncilRouter`
   * when a `resolve-worktree-op` command arrives). Returns `false` for an unknown / already
   * settled `requestId` — a stale reply (the request timed out / the run was killed and its
   * detached host op replied late) — so the router can log it, never throw.
   */
  resolve(requestId: string, reply: WorktreeOpReply): boolean {
    const settle = this.pending.get(requestId);
    if (settle === undefined) return false;
    settle(reply);
    return true;
  }
}
