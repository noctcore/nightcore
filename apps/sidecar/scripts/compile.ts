#!/usr/bin/env bun
//! Triple-aware sidecar compile step for Tauri's `externalBin`.
//!
//! Tauri resolves `externalBin: ["binaries/nightcore-sidecar"]` to
//! `binaries/nightcore-sidecar-<target-triple>` (`.exe` on Windows). `tauri_build`
//! hard-errors if that file is missing, so this script must emit the suffixed name.
//!
//! By default the triple comes from `rustc -vV` (native dev/CI). Release CI sets
//! `NIGHTCORE_SIDECAR_TARGET` when `tauri build --target …` cross-compiles (e.g.
//! Intel macOS on `macos-latest` — `macos-13` runners are deprecated).

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  bunCompileTarget,
  resolveSidecarTriple,
  sidecarExtension,
} from "./compile.utils";

const SIDECAR_ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(SIDECAR_ROOT, "src/index.ts");
const OUT_DIR = resolve(SIDECAR_ROOT, "../desktop/src-tauri/binaries");

function hostTargetTriple(): string {
  const rustInfo = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = /^host:\s*(\S+)$/m.exec(rustInfo);
  if (!match) {
    throw new Error(
      "could not determine host target triple from `rustc -vV` (no `host:` line)",
    );
  }
  return match[1];
}

function targetOverride(): string | undefined {
  const fromEnv = process.env.NIGHTCORE_SIDECAR_TARGET;
  if (fromEnv?.trim()) return fromEnv.trim();
  const idx = process.argv.indexOf("--target");
  if (idx >= 0) {
    const arg = process.argv[idx + 1];
    if (arg?.trim()) return arg.trim();
  }
  return undefined;
}

const hostTriple = hostTargetTriple();
const triple = resolveSidecarTriple(hostTriple, targetOverride());
const ext = sidecarExtension(triple);
const outfile = join(OUT_DIR, `nightcore-sidecar-${triple}${ext}`);
const crossTarget = bunCompileTarget(triple, hostTriple);

mkdirSync(dirname(outfile), { recursive: true });

console.log("building workspace references (tsc -b --force)");
execFileSync("bun", ["x", "tsc", "-b", "--force", "."], {
  stdio: "inherit",
  cwd: SIDECAR_ROOT,
});

const compileArgs = ["build", "--compile", "--outfile", outfile];
if (crossTarget) {
  compileArgs.push(`--target=${crossTarget}`);
  console.log(`cross-compiling sidecar (${hostTriple} → ${triple}, bun ${crossTarget})`);
}
compileArgs.push(ENTRY);

console.log(`compiling sidecar → ${outfile}`);
execFileSync("bun", compileArgs, { stdio: "inherit", cwd: SIDECAR_ROOT });