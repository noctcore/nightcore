/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import {
  bunCompileTarget,
  resolveSidecarTriple,
  sidecarExtension,
} from "./compile.utils";

describe("resolveSidecarTriple", () => {
  test("uses host when override is absent or blank", () => {
    expect(resolveSidecarTriple("aarch64-apple-darwin", undefined)).toBe(
      "aarch64-apple-darwin",
    );
    expect(resolveSidecarTriple("aarch64-apple-darwin", "  ")).toBe(
      "aarch64-apple-darwin",
    );
  });

  test("honours NIGHTCORE_SIDECAR_TARGET-style override", () => {
    expect(
      resolveSidecarTriple("aarch64-apple-darwin", "x86_64-apple-darwin"),
    ).toBe("x86_64-apple-darwin");
  });
});

describe("bunCompileTarget", () => {
  test("returns null for native host builds", () => {
    expect(bunCompileTarget("aarch64-apple-darwin", "aarch64-apple-darwin")).toBe(
      null,
    );
  });

  test("maps Intel macOS cross-compile from Apple Silicon CI", () => {
    expect(
      bunCompileTarget("x86_64-apple-darwin", "aarch64-apple-darwin"),
    ).toBe("bun-darwin-x64");
  });

  test("rejects unknown triples", () => {
    expect(() =>
      bunCompileTarget("wasm32-unknown-unknown", "aarch64-apple-darwin"),
    ).toThrow(/unsupported sidecar cross-compile/);
  });
});

describe("sidecarExtension", () => {
  test("adds .exe on Windows triples only", () => {
    expect(sidecarExtension("aarch64-apple-darwin")).toBe("");
    expect(sidecarExtension("x86_64-pc-windows-msvc")).toBe(".exe");
  });
});