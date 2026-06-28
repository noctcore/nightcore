/** Resolvers for Nightcore's on-disk locations (home, sessions, per-project). */
import * as os from 'node:os';
import * as path from 'node:path';

/** The global Nightcore home directory: `~/.nightcore`. */
export function nightcoreHome(): string {
  return path.join(os.homedir(), '.nightcore');
}

/** The session-metadata directory under the home dir. */
export function sessionsDir(home = nightcoreHome()): string {
  return path.join(home, 'sessions');
}

/** The per-project `.nightcore` directory for a given project root. */
export function projectDir(projectRoot: string): string {
  return path.join(projectRoot, '.nightcore');
}
