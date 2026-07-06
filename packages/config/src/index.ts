/** Layered Nightcore config resolution: defaults → user home → project, merged and validated. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type Config,
  type ConfigFile,
  ConfigFileSchema,
  ConfigSchema,
} from '@nightcore/contracts';
import {
  type Logger,
  nightcoreHome,
  projectDir,
  sessionsDir,
  tryCatch,
} from '@nightcore/shared';

const CONFIG_FILENAME = 'config.json';

/** Read and validate a single config file. Missing files and parse/validation
 *  errors degrade to an empty layer (logged at debug) rather than throwing —
 *  a malformed project config should not brick the harness. */
function readLayer(dir: string, logger?: Logger): ConfigFile {
  const file = path.join(dir, CONFIG_FILENAME);
  const read = tryCatch(() => fs.readFileSync(file, 'utf8'));
  if (!read.ok) return {};

  const parsed = tryCatch(() => JSON.parse(read.value) as unknown);
  if (!parsed.ok) {
    logger?.warn(`ignoring malformed config: ${file}`, parsed.error);
    return {};
  }

  const validated = ConfigFileSchema.safeParse(parsed.value);
  if (!validated.success) {
    logger?.warn(`ignoring invalid config: ${file}`, validated.error.issues);
    return {};
  }
  return validated.data;
}

/** Merge config layers, lowest precedence first. Later layers win, but only for
 *  keys they set explicitly — `ConfigFileSchema` carries no defaults and zod
 *  omits absent optional keys, so a layer only ever carries the keys its file set
 *  and an absent key inherits rather than clobbers.
 *
 *  The copy is key-DRIVEN (a shallow spread), not a hand-enumeration of every
 *  field: a new scalar added to `ConfigFileSchema` participates in layering for
 *  free, with no edit here. `permissions` is the one special case — merged one
 *  level deep so a project can override `mode` without dropping the inherited
 *  allow/deny lists. Its inherited value is captured before the spread (which
 *  would otherwise clobber it wholesale) and re-merged after. */
export function mergeLayers(...layers: ConfigFile[]): ConfigFile {
  let out: ConfigFile = {};
  for (const layer of layers) {
    const inheritedPermissions = out.permissions;
    out = { ...out, ...layer };
    if (layer.permissions !== undefined) {
      out.permissions = { ...inheritedPermissions, ...layer.permissions };
    }
  }
  return out;
}

/** Options controlling how {@link resolveConfig} locates config layers. */
export interface ResolveConfigOptions {
  /** Project root to look for `./.nightcore/config.json`. Defaults to cwd. */
  cwd?: string;
  /** Override the home dir (testing). */
  home?: string;
  logger?: Logger;
}

/**
 * Resolve the layered Nightcore config: defaults → `~/.nightcore/config.json` →
 * `<cwd>/.nightcore/config.json`, then attach resolved paths and validate the
 * whole thing through `ConfigSchema` (which fills defaults).
 */
export function resolveConfig(options: ResolveConfigOptions = {}): Config {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? nightcoreHome();

  const userLayer = readLayer(home, options.logger);
  const projectLayer = readLayer(projectDir(cwd), options.logger);
  const merged = mergeLayers(userLayer, projectLayer);

  const hasProjectConfig = fs.existsSync(
    path.join(projectDir(cwd), CONFIG_FILENAME),
  );

  // The Rust core's studio-wide `provider` setting reaches the engine through the
  // `NIGHTCORE_PROVIDER` env override (the sidecar spawn injects it — issue #18
  // Phase 4). It is the highest-precedence provider source so a provider swap in the
  // desktop settings takes effect without touching a config file; an unset/empty var
  // inherits the config-file value, then the `claude` default. Consistent with the
  // binary-resolution env overrides (`NIGHTCORE_AGENT_PATH`/`NIGHTCORE_CLAUDE_PATH`).
  const providerOverride = process.env.NIGHTCORE_PROVIDER?.trim();

  return ConfigSchema.parse({
    ...merged,
    ...(providerOverride ? { provider: providerOverride } : {}),
    paths: {
      home,
      project: hasProjectConfig ? projectDir(cwd) : undefined,
      sessions: sessionsDir(home),
    },
  });
}
