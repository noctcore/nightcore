import type { IPinnedTool, LinuxArch } from './pins.js';

export interface IFetchDeps {
  /** Download a release path under https://github.com/. */
  readonly download: (path: string) => Promise<Uint8Array>;
  readonly sha256: (bytes: Uint8Array) => string;
  /** Unpack `member` of the archive into `dir`, returning the binary's path. */
  readonly unpack: (bytes: Uint8Array, member: string, dir: string) => string;
  /** Write an asset that is the binary itself into `dir` as `name`, returning its path. */
  readonly place: (bytes: Uint8Array, name: string, dir: string) => string;
  /** The version the installed binary reports, or null. */
  readonly versionOf: (binary: string, tool: IPinnedTool) => string | null;
}

/**
 * Download every pinned linux asset for `arch`, refuse any whose sha256 is not the
 * pinned one, unpack the binary into `dir` (or place it there, when the asset
 * is the binary), and require it to report the pinned version. Throws on the
 * first problem: CI must never lint with a tool it could not verify.
 */
export async function fetchPinned(
  tools: readonly IPinnedTool[],
  arch: LinuxArch,
  dir: string,
  deps: IFetchDeps,
): Promise<readonly string[]> {
  const installed: string[] = [];
  for (const tool of tools) {
    const archive = tool.linux[arch];
    const bytes = await deps.download(archive.path);
    const digest = deps.sha256(bytes);
    if (digest !== archive.sha256) {
      throw new Error(
        `${tool.name} ${tool.version}: ${archive.path} has sha256 ${digest}, pinned ${archive.sha256}`,
      );
    }
    const binary =
      archive.member === undefined
        ? deps.place(bytes, tool.name, dir)
        : deps.unpack(bytes, archive.member, dir);
    const version = deps.versionOf(binary, tool);
    if (version !== tool.version) {
      throw new Error(
        `${tool.name}: the unpacked binary reports ${String(version)}, pinned ${tool.version}`,
      );
    }
    installed.push(`${tool.name} ${tool.version}`);
  }
  return installed;
}
