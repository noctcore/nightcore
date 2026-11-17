/*
 * Putting a downloaded binary where a later step will run it. The bytes are
 * verified before this is called (fetchPinned checks the sha256 first), so
 * what is left to get wrong is the destination: `writeFile` on a path that is
 * already a symlink writes THROUGH the link, into whatever it points at. So
 * the binary is written to a new file beside its final name (the write fails
 * if that name exists) and renamed into place: a rename replaces the entry at
 * the destination, link or file, and never follows it.
 */
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface IPlaceIo {
  /** Create `path` with `bytes`. Must fail when anything already has that name. */
  readonly writeNew: (path: string, bytes: Uint8Array) => void;
  readonly chmod: (path: string, mode: number) => void;
  /** Make `to` name what `from` names. An entry at `to` is replaced, never followed. */
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
}

export const nodePlaceIo: IPlaceIo = {
  // `wx`: O_CREAT | O_EXCL, which also refuses a dangling symlink.
  writeNew: (path, bytes) => writeFileSync(path, bytes, { flag: 'wx' }),
  chmod: (path, mode) => chmodSync(path, mode),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
};

/**
 * Write `bytes` into `dir` as the executable `name` and return its path.
 * `token` keeps the staging name of two runs apart.
 */
export function placeBinary(
  bytes: Uint8Array,
  name: string,
  dir: string,
  token: string,
  io: IPlaceIo = nodePlaceIo,
): string {
  const binary = join(dir, name);
  const staged = join(dir, `.${name}.${token}.partial`);
  io.writeNew(staged, bytes);
  try {
    io.chmod(staged, 0o755);
    io.rename(staged, binary);
  } catch (error) {
    io.remove(staged);
    throw error;
  }
  return binary;
}
