/**
 * Create a counter that only ever climbs and never resets across respawns. The
 * SessionManager uses one of these for session ids so a late event from a dead
 * runner carries an id absent from the live map and is dropped, instead of
 * resolving the wrong session.
 *
 * Starting at 1 keeps 0 available as a sentinel "no session" value.
 *
 * @param start - first value returned (defaults to 1)
 * @returns a function that returns the next integer on each call
 */
export function createMonotonicCounter(start = 1): () => number {
  let next = start;
  return () => next++;
}

/**
 * Opaque request-id generator for permission round-trips. Combines a monotonic
 * counter with a short random suffix so ids are unique even across process
 * restarts within the same session-resume flow.
 */
export function createRequestIdFactory(prefix = 'req'): () => string {
  const counter = createMonotonicCounter();
  return () => `${prefix}_${counter()}_${Math.random().toString(36).slice(2, 8)}`;
}
