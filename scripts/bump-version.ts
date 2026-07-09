#!/usr/bin/env bun
/** Fan a semver out to the four release-critical manifests (issue #16 SoT). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const TARGETS = [
  { path: 'package.json', kind: 'json' as const, key: 'version' },
  { path: 'apps/desktop/package.json', kind: 'json' as const, key: 'version' },
  { path: 'apps/desktop/src-tauri/tauri.conf.json', kind: 'json' as const, key: 'version' },
  { path: 'apps/desktop/src-tauri/Cargo.toml', kind: 'cargo' as const },
];

function usage(): never {
  console.error('Usage: bun run scripts/bump-version.ts <semver>');
  console.error('Example: bun run release:bump 0.1.0');
  process.exit(1);
}

const next = process.argv[2];
if (!next || !SEMVER_RE.test(next)) usage();

for (const target of TARGETS) {
  const filePath = join(ROOT, target.path);
  const raw = readFileSync(filePath, 'utf8');

  if (target.kind === 'json') {
    const data = JSON.parse(raw) as Record<string, unknown>;
    data[target.key] = next;
    writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
    continue;
  }

  const versionRe = /^version = ".*"$/m;
  if (!versionRe.test(raw)) {
    console.error(`Could not find version field in ${target.path}`);
    process.exit(1);
  }
  const updated = raw.replace(versionRe, `version = "${next}"`);
  if (updated !== raw) writeFileSync(filePath, updated);
}

console.log(`Bumped release version to ${next} across ${TARGETS.length} manifests.`);