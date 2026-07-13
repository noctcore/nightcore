/**
 * The append-only Council debate transcript store (issue #348, safety
 * non-negotiable #7).
 *
 * A council run is a governed multi-agent debate; every mediated write onto the bus
 * is recorded here as one immutable {@link DebateTranscriptEntry}, keyed by the
 * council-run id. Two invariants make the run auditable and replayable:
 *
 *  1. APPEND-ONLY. There is no API to mutate or delete an entry -- only
 *     {@link DebateTranscriptStore.append} and ordered reads. Each stored entry is
 *     frozen, so a holder of a read snapshot cannot alter the record either.
 *  2. ORDERED. The store assigns a per-run monotonic `seq` (and an `at` timestamp)
 *     on append; an ordered read reconstructs the exact sequence for replay.
 *
 * In-memory and process-local: this is the data model the (future) Rust Conductor
 * emit seam and a replay UI build on, forked from the run-keyed `Map` pattern the
 * Deep-Scan `ScanManager` uses for its active-run registry. Persistence to disk is a
 * downstream concern; the shape is the contract.
 */
import {
  type DebateTranscriptEntry,
  DebateTranscriptEntrySchema,
} from '@nightcore/contracts';

/** The fields a caller supplies on append. The store OWNS `seq` (the per-run
 *  ordering key) and `at` (the append timestamp) -- a caller cannot forge either,
 *  which is what keeps the ordering authoritative. */
export type DebateEntryInput = Omit<DebateTranscriptEntry, 'seq' | 'at'>;

/** An injectable clock so tests get deterministic `at` values. */
export type Clock = () => number;

export class DebateTranscriptStore {
  /** councilRunId -> its ordered, append-only entries. Private so the only mutation
   *  path is {@link append}; reads hand out frozen snapshots, never this array. */
  private readonly runs = new Map<string, DebateTranscriptEntry[]>();
  private readonly now: Clock;

  constructor(now: Clock = Date.now) {
    this.now = now;
  }

  /**
   * Append one entry to a council run's transcript and return the stored,
   * frozen record. The store assigns `seq` (0-based, monotonic per run) and `at`.
   * The constructed entry is validated against the contract schema before it is
   * stored, so a malformed entry can never enter the transcript. NEVER overwrites or
   * reorders -- append is the only mutation.
   */
  append(councilRunId: string, input: DebateEntryInput): DebateTranscriptEntry {
    const entries = this.runs.get(councilRunId) ?? [];
    if (!this.runs.has(councilRunId)) this.runs.set(councilRunId, entries);

    const entry = DebateTranscriptEntrySchema.parse({
      ...input,
      seq: entries.length,
      at: this.now(),
    });
    if (entry.injectionFlags !== undefined) Object.freeze(entry.injectionFlags);
    Object.freeze(entry);

    entries.push(entry);
    return entry;
  }

  /**
   * The ordered entries for a council run (ascending `seq`) -- an immutable snapshot
   * for replay. Returns a frozen copy so a reader cannot push/splice into the live
   * transcript; the entries themselves are already frozen. An unknown run reads as an
   * empty list.
   */
  read(councilRunId: string): readonly DebateTranscriptEntry[] {
    const entries = this.runs.get(councilRunId);
    return Object.freeze(entries === undefined ? [] : [...entries]);
  }

  /** How many entries a council run has recorded (also the next `seq` to be
   *  assigned). Zero for an unknown run. */
  size(councilRunId: string): number {
    return this.runs.get(councilRunId)?.length ?? 0;
  }

  /** Every council-run id that has at least one entry -- a frozen snapshot for
   *  cross-run replay/enumeration. */
  runIds(): readonly string[] {
    return Object.freeze([...this.runs.keys()]);
  }
}
