import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WireImage } from '@nightcore/contracts';

import type { StartSessionParams } from '../agent-provider.js';
import type { Input } from './sdk-adapter.js';

/**
 * Image attachments materialized to disk for one Codex turn: the absolute temp-file
 * paths and a best-effort cleanup that removes the whole temp directory.
 */
interface MaterializedCodexImages {
  readonly paths: string[];
  /** Remove the temp directory and every file in it. Best-effort and idempotent —
   *  swallows errors so it can run in a `finally` without masking a run result. */
  cleanup(): void;
}

/**
 * Spill each {@link WireImage}'s bytes to a UNIQUE per-session temp directory and
 * return their absolute paths (for the Codex SDK's `local_image` `UserInput` entries)
 * plus a cleanup handle. The SDK's `local_image` input takes a filesystem PATH, but a
 * `WireImage` carries raw base64 bytes — so the bytes must be written to disk.
 *
 * SANDBOX NOTE: the sidecar (a separate Node process, NOT under Codex's sandbox)
 * writes these files; Codex only READS them while the turn runs. Codex's own sandbox
 * (`read-only` / `workspace-write` / …) restricts Codex's OWN writes and network, not
 * its reads, so an absolute `os.tmpdir()` path is readable under every posture. The
 * paths MUST stay absolute — a `workspace-write` run's writable root is the cwd, so a
 * relative path would resolve against the repo, not the temp dir.
 *
 * The directory is created atomically with a random suffix ({@link mkdtempSync}) so
 * concurrent sessions never collide, and is torn down here on failure so a partially
 * written attachment set never leaks.
 */
function materializeCodexImages(
  sessionId: number,
  images: readonly WireImage[],
): MaterializedCodexImages {
  const dir = mkdtempSync(join(tmpdir(), `nightcore-codex-images-${sessionId}-`));
  const removeDir = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort: a temp dir we can't remove must never mask a run result (or a
      // genuine failure). The OS reaps os.tmpdir() eventually.
    }
  };
  try {
    const paths = images.map((image, index) => {
      const path = join(dir, `${index}.${image.format}`);
      writeFileSync(path, Buffer.from(image.data, 'base64'));
      return path;
    });
    return { paths, cleanup: removeDir };
  } catch (error) {
    removeDir();
    throw error;
  }
}

/**
 * Compose the Codex FIRST-TURN input for a run: the context pack + persona + prompt
 * joined as text, plus any image attachments materialized to `local_image` temp
 * files. Follow-up turns are text-only (the resumed thread retains context), so this
 * runs once per session.
 *
 * With no images the input is the plain joined string — byte-identical to the
 * pre-image path. With images it is a `UserInput[]`: the text first, then one
 * `local_image` per image at an absolute temp-file path. When images were spilled to
 * disk, `cleanup` MUST be invoked (in a `finally`) to remove them on EVERY exit —
 * completion, failure, or interrupt — so a run never leaks user-image bytes;
 * `cleanup` is `undefined` when there was nothing to remove.
 */
export function buildCodexFirstTurnInput(
  params: Pick<
    StartSessionParams,
    'sessionId' | 'appendContextPack' | 'prompt' | 'images'
  >,
  appendSystemPrompt: string | undefined,
): { input: Input; cleanup?: () => void } {
  const text = [params.appendContextPack, appendSystemPrompt, params.prompt]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('\n\n');
  if (params.images === undefined || params.images.length === 0) {
    return { input: text };
  }
  const materialized = materializeCodexImages(params.sessionId, params.images);
  return {
    input: [
      { type: 'text', text },
      ...materialized.paths.map((path) => ({ type: 'local_image' as const, path })),
    ],
    cleanup: materialized.cleanup,
  };
}
