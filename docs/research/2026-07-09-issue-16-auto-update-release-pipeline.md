# Issue #16 — Tauri v2 Auto-Update + Release Pipeline

**Date:** 2026-07-09  
**Issue:** [Shironex/nightcore#16](https://github.com/Shironex/nightcore/issues/16)  
**Prior research:** [2026-06-21-auto-update-system.md](./2026-06-21-auto-update-system.md)  
**Constraint:** No OS code signing (no Apple Developer ID / notarization, no Windows Authenticode). Minisign-verified updater only.

---

## Executive summary

**Nothing from issue #16 is implemented yet.** The repo has CI (`ci.yml`) and dependency audit (`audit.yml`), but zero updater wiring, no release workflow, no minisign keys, and all shipping version markers remain `0.0.0`. The Bun sidecar compile script is host-triple-only (explicitly no cross-compile), which is compatible with **Option A** (native per-arch CI runners) but is a hard blocker for building Intel macOS artifacts on `macos-latest` without Option A or Option B.

The work splits cleanly into three layers:

1. **Updater plumbing** — Rust/JS deps, plugin registration, `tauri.conf.json`, capabilities.
2. **Release pipeline** — minisign keypair + GH secrets, version SoT, `release.yml` tauri-action matrix.
3. **In-app UX** — `UpdateChecker` component on Settings → About, manual + optional startup check, idle-gated relaunch.

Estimated effort: **COMPLEX** (cross-cutting Rust + web + CI + one-time secret setup + manual dogfood on real published releases).

---

## Issue checklist vs repo state (verified 2026-07-09)

| # | Concern | Current state | Status |
|---|---------|---------------|--------|
| 1 | Minisign keypair + GH secrets | No keys, no secrets referenced anywhere in repo | ❌ Missing |
| 2 | `tauri-plugin-updater` + `tauri-plugin-process` in `Cargo.toml` | Only `tauri-plugin-dialog`, `tauri-plugin-notification` | ❌ Missing |
| 3 | Plugin registration in `lib.rs` | Dialog + notification only; no updater/process | ❌ Missing |
| 4 | JS deps `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process` | `apps/web/package.json` has `@tauri-apps/api`, `@tauri-apps/plugin-dialog` only | ❌ Missing |
| 5 | `tauri.conf.json` — `createUpdaterArtifacts`, `plugins.updater`, `bundle.macOS.signingIdentity: "-"` | `bundle` has `externalBin`, `targets: "all"`; no `plugins` block, no updater artifacts, no macOS signing | ❌ Missing |
| 6 | Capabilities — `updater:default`, `process:allow-restart` | `core:default`, `dialog:allow-open`, `notification:default` only | ❌ Missing |
| 7 | Sidecar arch matrix | `compile.ts` reads **host** triple via `rustc -vV`; comment says cross-compile out of scope | ⚠️ OK for Option A; ❌ blocks Option B / single-runner cross-build |
| 8 | Version SoT (4 manifests @ `0.0.0`) | All four still `0.0.0`; no bump script | ❌ Missing |
| 9 | `release.yml` CI workflow | Only `ci.yml`, `audit.yml` exist | ❌ Missing |
| 10 | `UpdateChecker` UI | No component; About page shows static version pill via `app_info` | ❌ Missing |

### Version markers (the “4 manifests”)

Issue #16 targets these four (all currently `0.0.0`):

| File | Field | Value |
|------|-------|-------|
| `package.json` (root) | `version` | `0.0.0` |
| `apps/desktop/package.json` | `version` | `0.0.0` |
| `apps/desktop/src-tauri/Cargo.toml` | `version` | `0.0.0` |
| `apps/desktop/src-tauri/tauri.conf.json` | `version` | `0.0.0` |

`app_info` reads `env!("CARGO_PKG_VERSION")` → About page will show `0.0.0` until `Cargo.toml` is bumped.

Other workspace packages (`apps/web`, `apps/sidecar`, `packages/*`) also carry `0.0.0` but are **not** in the issue’s release-critical four.

---

## Key file snapshots (ground truth)

### `apps/desktop/src-tauri/Cargo.toml`

- Tauri `2.11.2`, `rust-version = "1.77.2"` (CI pins `1.94.1` via `rust-toolchain.toml`)
- Plugins: `tauri-plugin-dialog = "2.7"`, `tauri-plugin-notification = "2.3"`
- **Missing:** `tauri-plugin-updater = "2"`, `tauri-plugin-process = "2"`

### `apps/desktop/src-tauri/src/lib.rs`

- Plugins registered on `Builder` before `.setup()`:
  ```rust
  .plugin(tauri_plugin_dialog::init())
  .plugin(tauri_plugin_notification::init())
  ```
- **Missing:** updater + process plugins (issue #16 places both on the builder chain, matching existing pattern)

### `apps/desktop/src-tauri/tauri.conf.json`

- `bundle.externalBin`: `["binaries/nightcore-sidecar"]` ✅ (sidecar wired)
- `bundle.targets`: `"all"` (emits `.dmg`/`.msi` in addition to updater artifacts — harmless but noisy)
- `beforeBuildCommand`: web build + sidecar compile ✅
- **Missing:** `createUpdaterArtifacts: true`, `plugins.updater` block, `bundle.macOS.signingIdentity: "-"`
- CSP unchanged — correct; updater fetches via Rust/`reqwest`, not webview `fetch`

### `apps/desktop/src-tauri/capabilities/default.json`

```json
"permissions": ["core:default", "dialog:allow-open", "notification:default"]
```

**Missing:** `"updater:default"`, `"process:allow-restart"`

Note: `$schema` points at `../gen/schemas/desktop-schema.json` (generated at build time, not committed). Adding permissions may require `tauri dev` / `cargo build` once to regenerate schemas locally.

### `apps/sidecar/scripts/compile.ts`

- Resolves host triple from `rustc -vV` `host:` line
- Outputs `apps/desktop/src-tauri/binaries/nightcore-sidecar-<triple>[.exe]`
- Explicit comment: *"Cross-compiling to a different triple is out of scope"*
- **Implication:** On `macos-latest` with `--target x86_64-apple-darwin`, compile.ts would emit an **arm64** binary with an x86_64 filename → Tauri `build.rs` hard-error or runtime failure. **Option A (native runners) is required until Option B is implemented.**

### Workflows

| Workflow | Purpose |
|----------|---------|
| `.github/workflows/ci.yml` | Lint, typecheck, test, rust-checks, ts-rs drift |
| `.github/workflows/audit.yml` | Bun + Rust CVE audit |
| `.github/workflows/release.yml` | **Does not exist** |

`ci.yml` already runs `bun run test:rust` which compiles the sidecar — good pre-merge gate, but does not exercise release bundling or updater artifacts.

### Web / About integration points

- **About cards:** `apps/web/src/components/settings/settings-about-cards.tsx` — version from `appInfo.version`, repo link
- **App info bridge:** `getAppInfo()` → `app_info` command → `CARGO_PKG_VERSION`
- **Settings shell:** `SettingsView.tsx` — About page under SYSTEM nav group
- **Idle signal available:** `runningTaskCount(tasks)` in `AppShell.hooks.ts` counts `in_progress` + `verifying` tasks via `isActive()` from `components/board/status.ts`
- **Component convention:** folder-per-component (e.g. `ValidateControls/ValidateControls.tsx`, `.hooks.ts`, `.types.ts`, `.test.tsx`, `.stories.tsx`, `index.ts`)

### Prior research alignment

[2026-06-21-auto-update-system.md](./2026-06-21-auto-update-system.md) covers the same architecture. Issue #16 **supersedes** it on:

- Per-arch macOS artifacts (no universal binary — `tauri#3355` + Bun can't emit fat binaries)
- `bundle.macOS.signingIdentity: "-"` as **mandatory** for arm64 updater (not optional ad-hoc)
- Draft → QA → publish release gate
- `updaterJsonPreferNsis: true`
- Nightcore-specific sidecar arch hazard

---

## Files to create

| File | Purpose |
|------|---------|
| `.github/workflows/release.yml` | tauri-action matrix (macOS arm64 + macOS Intel + Windows) |
| `scripts/bump-version.ts` | Single-command semver bump + fan-out to 4 manifests + optional git tag |
| `apps/web/src/components/settings/UpdateChecker/UpdateChecker.tsx` | Manual check UI + install/relaunch flow |
| `apps/web/src/components/settings/UpdateChecker/UpdateChecker.hooks.ts` | `check()`, `downloadAndInstall()`, progress state, idle gate |
| `apps/web/src/components/settings/UpdateChecker/UpdateChecker.types.ts` | Props + state types |
| `apps/web/src/components/settings/UpdateChecker/UpdateChecker.test.tsx` | Vitest browser tests (mock updater outside Tauri) |
| `apps/web/src/components/settings/UpdateChecker/UpdateChecker.stories.tsx` | Storybook states (idle, checking, available, installing, deferred) |
| `apps/web/src/components/settings/UpdateChecker/index.ts` | Barrel export |

Optional but recommended:

| File | Purpose |
|------|---------|
| `docs/releasing.md` | Human runbook: bump → tag → draft QA → publish → checksums |
| `.github/CODEOWNERS` | Protect `release.yml` (issue R1: workflow edit ≡ key compromise) |

**Not committed (manual / secrets):**

- Minisign private key → GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- Public key content → `tauri.conf.json` `plugins.updater.pubkey`
- GitHub **environment** `release` with required reviewers (recommended)

---

## Files to modify

| File | Changes |
|------|---------|
| `apps/desktop/src-tauri/Cargo.toml` | Add updater + process plugin deps; version bump |
| `apps/desktop/src-tauri/Cargo.lock` | Regenerated on `cargo build` |
| `apps/desktop/src-tauri/src/lib.rs` | Register `tauri_plugin_updater` + `tauri_plugin_process` |
| `apps/desktop/src-tauri/tauri.conf.json` | `createUpdaterArtifacts`, `plugins.updater`, `bundle.macOS.signingIdentity: "-"` |
| `apps/desktop/src-tauri/capabilities/default.json` | `updater:default`, `process:allow-restart` |
| `apps/web/package.json` | Add `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`; version bump |
| `bun.lock` | Regenerated on `bun install` |
| `package.json` (root) | Version SoT; add `release:bump` script |
| `apps/desktop/package.json` | Version fan-out |
| `apps/web/src/components/settings/settings-about-cards.tsx` | Mount `UpdateChecker` row/card |
| `apps/web/src/components/settings/SettingsView/SettingsView.types.ts` | Optional `isAppIdle` prop |
| `apps/web/src/components/app/AppShell/AppShell.tsx` | Pass `isAppIdle={runningCount === 0}` to `SettingsView` |
| `apps/web/src/components/settings/index.ts` | Re-export `UpdateChecker` if needed |

**Deferred (Option B — not for v1):**

| File | Changes |
|------|---------|
| `apps/sidecar/scripts/compile.ts` | Accept `--target` / `TAURI_TARGET` env; map to `bun build --compile --target=bun-darwin-arm64\|x64\|windows-x64` |

---

## Implementation order

### Phase 0 — Prerequisites (human, blocks everything)

1. Generate minisign keypair:
   ```bash
   cd apps/desktop && bunx tauri signer generate -w ~/.tauri/nightcore-updater.key
   ```
2. Store **private key file content** + password as GitHub Actions secrets (prefer `release` environment with reviewers).
3. Copy **public key content** (not path) for `tauri.conf.json`.
4. Back up keypair offline — key loss/rotation bricks auto-update for all installed clients (issue R4).

### Phase 1 — Updater plumbing (local dev)

5. Add `tauri-plugin-updater = "2"` and `tauri-plugin-process = "2"` to `Cargo.toml`.
6. Register plugins in `lib.rs` on the builder chain (after notification).
7. Add `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` to `apps/web/package.json`; `bun install`.
8. Update `tauri.conf.json`:
   - `"createUpdaterArtifacts": true` under `bundle`
   - `"macOS": { "signingIdentity": "-" }` under `bundle`
   - `"plugins": { "updater": { "pubkey": "<content>", "endpoints": ["https://github.com/Shironex/nightcore/releases/latest/download/latest.json"], "windows": { "installMode": "passive" } } }`
9. Add `"updater:default"` and `"process:allow-restart"` to `capabilities/default.json`.
10. Verify local build compiles: `bun run desktop:build` (will not produce signed artifacts without secrets, but should compile).

### Phase 2 — Version SoT

11. Create `scripts/bump-version.ts` — reads/writes semver across the 4 manifests atomically.
12. Add root script, e.g. `"release:bump": "bun run scripts/bump-version.ts"`.
13. Baseline first real version (e.g. `0.1.0`) across all four before first tagged release.

### Phase 3 — Release CI (Option A)

14. Create `.github/workflows/release.yml` per issue spec:
    - Trigger: `push: tags: ['v*.*.*']` + `workflow_dispatch`
    - Matrix: `macos-latest` (`--target aarch64-apple-darwin`), `macos-13` (`--target x86_64-apple-darwin`), `windows-latest`
    - `projectPath: apps/desktop/src-tauri`
    - `releaseDraft: true`, `updaterJsonPreferNsis: true`
    - Env: `GITHUB_TOKEN`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only (no cert secrets)
    - Steps: checkout → setup-bun → rust-toolchain → rust-cache → `bun install` → tauri-action
15. `compile.ts` unchanged under Option A — each runner is native.

### Phase 4 — UpdateChecker UI

16. Create `UpdateChecker/` component folder per repo convention.
17. Hook logic:
    ```ts
    import { check } from '@tauri-apps/plugin-updater'
    import { relaunch } from '@tauri-apps/plugin-process'
    ```
    - Manual "Check for updates" button (primary path)
    - Optional: check once on app startup after delay (settings toggle or hardcoded v1 default: startup check ON with 30s delay)
    - On update available: show version, notes, Install button
    - **Idle gate:** if `!isAppIdle` (running tasks > 0), show "Finish active runs first" and disable install/relaunch
    - On install: `downloadAndInstall(onProgress)` → confirm → `relaunch()`
    - Outside Tauri: no-op / hidden (match `isTauri()` pattern from bridge)
18. Integrate into About page via `settings-about-cards.tsx` (new row or card below version pill).
19. Thread `isAppIdle` from `AppShell` → `SettingsView` → `UpdateChecker`.
20. Add tests + stories.

### Phase 5 — Dogfood (not CI-gated)

21. Bump to `0.1.0`, commit, tag `v0.1.0`, push.
22. Wait for draft release; QA artifacts on arm64 Mac, Intel Mac (or Rosetta test), Windows.
23. Install `0.1.0` build manually; publish release; verify `latest.json` redirect.
24. Bump to `0.1.1`, publish; verify in-app updater on all three platforms.
25. Document first-install workarounds (Gatekeeper / SmartScreen) + SHA-256 checksums in release notes.

---

## Concrete config snippets (from issue #16)

### `tauri.conf.json` additions

```jsonc
{
  "bundle": {
    "createUpdaterArtifacts": true,
    "macOS": { "signingIdentity": "-" },
    // existing: externalBin, targets, icon, ...
  },
  "plugins": {
    "updater": {
      "pubkey": "<MINISIGN_PUBLIC_KEY_CONTENT>",
      "endpoints": [
        "https://github.com/Shironex/nightcore/releases/latest/download/latest.json"
      ],
      "windows": { "installMode": "passive" }
    }
  }
}
```

### `lib.rs` additions

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

### `release.yml` matrix (Option A)

```yaml
matrix:
  include:
    - platform: macos-latest
      args: --target aarch64-apple-darwin
    - platform: macos-13
      args: --target x86_64-apple-darwin
    - platform: windows-latest
      args: ''
```

---

## Open decisions + recommended defaults

| Decision | Options | **Recommendation** |
|----------|---------|---------------------|
| Sidecar arch matrix | A: native runners (`macos-13` Intel) vs B: target-aware `compile.ts` | **Option A for v1** — zero sidecar code risk; file Option B follow-up issue |
| Updater UX timing | Startup-only vs manual-only vs both | **Manual button on About + optional startup check (30s delay)**; always idle-gated |
| `bundle.targets` | `"all"` vs `["app", "nsis"]` | Keep `"all"` for v1 (extra `.dmg`/`.msi` harmless); narrow later if release page clutter matters |
| First semver | `0.1.0` vs `1.0.0` | **`0.1.0`** — pre-1.0 per `SECURITY.md`; establishes updater baseline |
| Release environment | Plain secrets vs GH Environment w/ reviewers | **GH `release` environment** with required reviewers |
| Startup update setting | Hardcoded vs user preference | Hardcoded v1; add `settings.checkUpdatesOnStartup` later if needed |
| Checksum publication | Release notes only vs separate `checksums.txt` asset | **`checksums.txt` + minisign pubkey** on each published release (mitigates R3) |

---

## Risks (from issue #16, repo-grounded)

| ID | Risk | Mitigation in this plan |
|----|------|-------------------------|
| R1 | Minisign private key leak → signed malware trusted by all clients | GH environment secrets, CODEOWNERS on `release.yml`, never commit key |
| R2 | macOS arm64 updater breaks without ad-hoc sig | `bundle.macOS.signingIdentity: "-"` in `tauri.conf.json` |
| R3 | Unsigned distro trains users to bypass OS malware nets | Document workarounds + publish checksums; roadmap OS signing in issue |
| R4 | Key loss/rotation bricks existing installs | Offline backup; treat rotation as emergency |
| R5 | Windows SmartScreen never clears without cert | Accepted cost; document "Run anyway" |
| R6 | `macos-13` runner deprecation | Monitor GitHub changelog; migrate to Option B before removal |
| R7 | macOS `relaunch()` flakiness (`tauri#11392`) | Dogfood explicitly; fallback "Restart manually" message |
| R8 | Sidecar arch mismatch on cross-compile | Option A only until `compile.ts` is target-aware |

---

## Verification commands

### Local (after Phase 1)

```bash
# Install new JS deps
bun install

# Rust compile + existing test gate
bun run test:rust

# Full workspace gate
bun run test:all

# Lint / typecheck
bun run lint && bun run typecheck

# Release build (unsigned artifacts, no minisign without secrets)
bun run desktop:build
```

### After Phase 2

```bash
bun run release:bump 0.1.0
# Assert all four manifests show 0.1.0
grep '"version"' package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json
grep '^version' apps/desktop/src-tauri/Cargo.toml
```

### After Phase 4

```bash
bun run --filter @nightcore/web test -- UpdateChecker
```

### Release pipeline (Phase 5 — requires secrets + tag)

```bash
git tag v0.1.0 && git push origin v0.1.0
# Watch: gh run list --workflow=release
# QA draft: gh release list
# After publish:
curl -sL https://github.com/Shironex/nightcore/releases/latest/download/latest.json | jq .
```

### Installed app dogfood

1. Install draft `0.1.0` manually on each platform.
2. Publish release.
3. Trigger "Check for updates" from Settings → About.
4. Verify download, minisign acceptance, install, relaunch to `0.1.1`.

---

## Relationship to existing docs

- **Supersedes** the implementation checklist in [2026-06-21-auto-update-system.md](./2026-06-21-auto-update-system.md) where they differ (universal binary, plugin registration style).
- **Complements** `SECURITY.md` (pre-1.0, no tagged release support yet).
- **Unblocks** shipping narrative in `README.md` once dogfood passes.

---

## Summary gap count

| Category | Done | Missing |
|----------|------|---------|
| Rust updater deps + registration | 0 | 2 files |
| JS updater deps | 0 | 1 file |
| Tauri config + capabilities | 0 | 2 files |
| Minisign / secrets | 0 | 3 secrets + pubkey in config |
| Version SoT | 0 | 4 manifests + bump script |
| Release CI | 0 | 1 workflow |
| Sidecar arch (Option A) | 0 workflow | compile.ts OK as-is |
| UpdateChecker UI | 0 | 1 component folder + 3 integration files |

**Total: 0/10 checklist items complete.**