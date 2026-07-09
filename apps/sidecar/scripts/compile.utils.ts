/** Maps Rust target triples to Bun cross-compile targets for the sidecar binary. */

const BUN_CROSS_TARGET: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
};

/** Resolve the Rust triple Tauri expects for the sidecar artifact name. */
export function resolveSidecarTriple(
  hostTriple: string,
  override: string | undefined,
): string {
  const trimmed = override?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : hostTriple;
}

/** Bun `--target` for cross-compilation, or `null` when host-native is enough. */
export function bunCompileTarget(
  triple: string,
  hostTriple: string,
): string | null {
  if (triple === hostTriple) return null;
  const cross = BUN_CROSS_TARGET[triple];
  if (!cross) {
    throw new Error(
      `unsupported sidecar cross-compile triple "${triple}" (host is ${hostTriple})`,
    );
  }
  return cross;
}

/** File extension for a bundled sidecar on this triple. */
export function sidecarExtension(triple: string): string {
  return triple.includes("-windows-") ? ".exe" : "";
}