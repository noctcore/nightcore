/**
 * Build-time codegen: mirror the app's five-stage model into the docs site.
 *
 * `apps/web/src/lib/stages.ts` is the single source of truth for what each stage
 * of the governed lifecycle is called, what it does, and what it leaves behind
 * (issue #404). The docs site MUST NOT restate that vocabulary in prose — the
 * two copies would drift the first time a stage is renamed and nobody would
 * notice, because nothing checks a paragraph.
 *
 * So the site does not carry a second copy. `bun run build` in `apps/docs` runs
 * this script FIRST, which imports the real module and writes
 * `src/generated/stages.json`. The generated file is git-ignored, so there is no
 * committed copy that can go stale, and the site literally cannot build without
 * reading the app's source of truth.
 *
 * This relative import into a sibling surface is the ONE declared seam between
 * `apps/docs` and `apps/web` (see `apps/docs/AGENTS.md`). It is build-time only,
 * it reads a pure-data module with no React and no imports of its own, and
 * nothing is shipped from `apps/web` into the docs bundle.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { STAGES } from '../../web/src/lib/stages';

const OUT_DIR = path.join(import.meta.dir, '..', 'src', 'generated');
const OUT_FILE = path.join(OUT_DIR, 'stages.json');

const payload = {
  /** Provenance, so a reader of the generated file knows not to hand-edit it. */
  $source: 'apps/web/src/lib/stages.ts (via apps/docs/scripts/gen-stages.ts)',
  stages: STAGES.map((stage, index) => ({
    number: index + 1,
    id: stage.id,
    label: stage.label,
    destination: stage.destination,
    verb: stage.verb,
    summary: stage.summary,
    produces: stage.produces,
  })),
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

process.stdout.write(`gen-stages: wrote ${payload.stages.length} stages to src/generated/stages.json\n`);
