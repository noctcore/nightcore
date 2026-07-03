/** Append-only JSONL persistence for Nightcore session metadata. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { type SessionRecord,SessionRecordSchema } from '@nightcore/contracts';
import { type Logger,sessionsDir, tryCatch } from '@nightcore/shared';

/** True when a captured fs error is "file does not exist" (ENOENT) — the normal
 *  cold-start case, distinct from a real read failure worth logging. */
function isFileNotFound(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Minimal local persistence for Nightcore session metadata. We deliberately do
 * NOT store transcripts — the SDK owns those as resumable JSONL on disk. This
 * store keeps only the bookkeeping the harness needs (tags, status, cost, the
 * mapping from our monotonic id to the SDK session UUID).
 *
 * Storage format is append-only JSONL at `<home>/sessions/index.jsonl`: one
 * record per line, last-write-wins on read. Append-only keeps writes atomic and
 * crash-safe without a real database — adequate for a single-user local tool.
 */
/** A parsed snapshot of the JSONL, tagged with the file stat it was built from so
 *  a later read can detect whether the file changed without re-parsing it. */
interface CacheEntry {
  /** id → record, last-write-wins (the collapsed view of the append log). */
  readonly byId: Map<number, SessionRecord>;
  /** Records newest-first — the exact `list()` return, memoized to avoid resorting. */
  readonly sorted: SessionRecord[];
  /** File size the snapshot was parsed from (append-only ⇒ size always grows on write). */
  readonly size: number;
  /** File mtime (ms) the snapshot was parsed from (defends against same-size rewrites). */
  readonly mtimeMs: number;
}

export class SessionStore {
  private readonly file: string;
  /** Memoized parse of `index.jsonl`, keyed on the file's size+mtime. Repeated
   *  `list()`/`get()` calls reuse it after a single cheap `stat`; a write (our own
   *  append or an external edit) changes size/mtime and invalidates it on next read.
   *  Cost then scales with reads-since-last-write, not with total history. */
  private cache?: CacheEntry;

  constructor(
    private readonly dir: string = sessionsDir(),
    private readonly logger?: Logger,
  ) {
    this.file = path.join(this.dir, 'index.jsonl');
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Append (or supersede) a session record. */
  save(record: SessionRecord): void {
    const validated = SessionRecordSchema.parse(record);
    this.ensureDir();
    const write = tryCatch(() =>
      fs.appendFileSync(this.file, `${JSON.stringify(validated)}\n`, 'utf8'),
    );
    if (!write.ok) {
      this.logger?.warn('failed to persist session record', write.error);
    }
    // Invalidate: the append grew the file, so the memoized snapshot is stale.
    // (The size/mtime guard in list() would catch this too, but dropping the
    //  entry here keeps the invariant explicit and avoids trusting a stale stat.)
    this.cache = undefined;
  }

  /** Read all records, collapsing duplicates by id (last write wins). */
  list(): SessionRecord[] {
    // Cheap freshness probe: one `stat` instead of a full read+parse+validate.
    // When it matches the cached snapshot's tag, reuse the memoized result —
    // this is the hot path for the startup id-seed scan and every session query.
    const stat = tryCatch(() => fs.statSync(this.file));
    if (!stat.ok) {
      if (!isFileNotFound(stat.error)) {
        this.logger?.warn('failed to read session store', stat.error);
      }
      this.cache = undefined;
      return [];
    }
    const { size, mtimeMs } = stat.value;
    if (
      this.cache !== undefined &&
      this.cache.size === size &&
      this.cache.mtimeMs === mtimeMs
    ) {
      return this.cache.sorted;
    }

    const read = tryCatch(() => fs.readFileSync(this.file, 'utf8'));
    if (!read.ok) {
      // A missing index file is the normal cold-start case — return [] silently.
      // Any OTHER read failure (permissions, I/O error, a directory in the way)
      // is real signal that records may be silently invisible: log it at warn.
      if (!isFileNotFound(read.error)) {
        this.logger?.warn('failed to read session store', read.error);
      }
      this.cache = undefined;
      return [];
    }

    const byId = new Map<number, SessionRecord>();
    for (const line of read.value.split('\n')) {
      if (!line.trim()) continue;
      const parsed = tryCatch(() => JSON.parse(line) as unknown);
      if (!parsed.ok) continue;
      const validated = SessionRecordSchema.safeParse(parsed.value);
      if (validated.success) byId.set(validated.data.id, validated.data);
    }
    const sorted = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
    this.cache = { byId, sorted, size, mtimeMs };
    return sorted;
    // Residual (deferred): the log is never compacted, so a repeatedly-saved id
    // leaves superseded lines that still get parsed on the first read after each
    // write. The cache bounds per-read cost between writes; bounding on-disk size
    // would need a periodic rewrite (a durability-sensitive change) — out of scope.
  }

  /** Look up a single record by Nightcore id. O(1) against the memoized index. */
  get(id: number): SessionRecord | undefined {
    // Refresh the cache if dirty (list() re-parses only when the file changed),
    // then hit the by-id map directly instead of scanning the sorted array.
    this.list();
    return this.cache?.byId.get(id);
  }
}
