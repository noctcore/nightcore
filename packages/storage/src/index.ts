/** Append-only JSONL persistence for Nightcore session metadata. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionRecordSchema, type SessionRecord } from '@nightcore/contracts';
import { sessionsDir, tryCatch, type Logger } from '@nightcore/shared';

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
export class SessionStore {
  private readonly file: string;

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
  }

  /** Read all records, collapsing duplicates by id (last write wins). */
  list(): SessionRecord[] {
    const read = tryCatch(() => fs.readFileSync(this.file, 'utf8'));
    if (!read.ok) {
      // A missing index file is the normal cold-start case — return [] silently.
      // Any OTHER read failure (permissions, I/O error, a directory in the way)
      // is real signal that records may be silently invisible: log it at warn.
      if (!isFileNotFound(read.error)) {
        this.logger?.warn('failed to read session store', read.error);
      }
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
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Look up a single record by Nightcore id. */
  get(id: number): SessionRecord | undefined {
    return this.list().find((r) => r.id === id);
  }
}
