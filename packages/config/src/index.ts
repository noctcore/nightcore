import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ConfigFileSchema,
  ConfigSchema,
  type Config,
  type ConfigFile,
} from '@nightcore/contracts';
import {
  nightcoreHome,
  sessionsDir,
  projectDir,
  tryCatch,
  type Logger,
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
 *  keys they set explicitly — `ConfigFileSchema` carries no defaults, so an
 *  absent key inherits rather than clobbers. `permissions` is merged one level
 *  deep so a project can override `mode` without dropping the inherited
 *  allow/deny lists. */
function mergeLayers(...layers: ConfigFile[]): ConfigFile {
  const out: ConfigFile = {};
  for (const layer of layers) {
    if (layer.model !== undefined) out.model = layer.model;
    if (layer.effort !== undefined) out.effort = layer.effort;
    if (layer.settingSources !== undefined)
      out.settingSources = layer.settingSources;
    if (layer.todoFeatureEnabled !== undefined)
      out.todoFeatureEnabled = layer.todoFeatureEnabled;
    if (layer.maxTurns !== undefined) out.maxTurns = layer.maxTurns;
    if (layer.maxBudgetUsd !== undefined) out.maxBudgetUsd = layer.maxBudgetUsd;
    if (layer.logLevel !== undefined) out.logLevel = layer.logLevel;
    if (layer.permissions !== undefined) {
      const p = layer.permissions;
      out.permissions = {
        ...out.permissions,
        ...(p.allow !== undefined ? { allow: p.allow } : {}),
        ...(p.deny !== undefined ? { deny: p.deny } : {}),
        ...(p.mode !== undefined ? { mode: p.mode } : {}),
      };
    }
  }
  return out;
}

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

  return ConfigSchema.parse({
    ...merged,
    paths: {
      home,
      project: hasProjectConfig ? projectDir(cwd) : undefined,
      sessions: sessionsDir(home),
    },
  });
}
