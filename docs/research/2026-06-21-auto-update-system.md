# Auto-Update System for Nightcore — Research

**Date:** 2026-06-21
**Scope:** Windows + macOS auto-updates, **no OS code signing**, no Linux (for now).
**Stack today:** Tauri v2 (`tauri 2.11.2`), Rust 1.77.2, Bun sidecar, `apps/desktop/src-tauri`. GitHub repo `Shironex/nightcore`. No updater plugin wired yet. _(Update 2026-06-27: `.github/` CI now exists — `ci.yml` is the lint/typecheck/test + codegen-drift gate and `audit.yml`/`dependabot.yml` cover CVEs; the release/update automation in §8 below is still unbuilt.)_

---

## TL;DR / Recommendation

Use the **official Tauri v2 `updater` plugin**. It is purpose-built for exactly this and works **without any OS code signing**.

The single most important finding:

> **Tauri's updater signature (minisign) is completely separate from OS code signing (Windows Authenticode / Apple Developer ID + notarization).**

The updater *requires its own* minisign keypair, which you generate yourself for free with the Tauri CLI. That signature is what guarantees an update payload is authentic. OS code signing is a *different, optional* thing that only affects the **first-run trust UX** (SmartScreen / Gatekeeper warnings). So:

- ✅ We **can** ship secure, signed-by-us auto-updates today, $0, no certificates.
- ⚠️ The cost of skipping OS signing is **install-time friction** (scary warnings), not broken updates — with one real macOS caveat (below).

**Hosting:** GitHub Releases (free, public repo) is the path of least resistance. We already have a Cloudflare account connected (R2) as a clean alternative if we don't want releases public.

---

## How the Tauri updater works (mental model)

1. App is built with `createUpdaterArtifacts: true`. This produces, alongside the normal installer, an **update artifact** + a **`.sig`** file:
   - **Windows:** the NSIS `*-setup.exe` (and `.exe.sig`). The updater downloads and silently re-runs the installer.
   - **macOS:** `*.app.tar.gz` (and `.app.tar.gz.sig`). The updater unpacks it and swaps the `.app` in place.
2. We publish those artifacts + a small JSON manifest (`latest.json`) somewhere reachable.
3. At runtime the app calls `check()`. The plugin fetches the manifest from configured `endpoints`, compares versions, and if newer **verifies the download against the embedded public key** before installing.
4. On success the app relaunches into the new version.

The version compared is the Tauri app version (`version` in `tauri.conf.json` / `Cargo.toml` — currently `0.0.0`, so we need real semver before this matters).

---

## What "no code signing" actually costs us, per platform

### Windows (works fine, ugly first install)
- Unsigned `.exe` → **SmartScreen** "Windows protected your PC" warning on first download/run. User clicks *More info → Run anyway*. After enough installs/reputation it softens, but unsigned never fully clears.
- **Auto-updates themselves work normally** — the updater re-runs the NSIS installer; minisign verification is what protects the payload.
- No Microsoft Store listing (irrelevant for us).
- Future fix if we want it: OV/EV Authenticode cert (~$200–400/yr) or Azure Trusted Signing (~$10/mo, but requires an org with a 3-yr history). Not blocking.

### macOS (works, but one real caveat)
- Unsigned/un-notarized `.app` downloaded via browser gets a **Gatekeeper quarantine** flag → "app is damaged / cannot be opened because the developer cannot be verified." User must right-click → Open, or `xattr -cr` the app. This is a worse first-run experience than Windows.
- **Updater caveat:** Tauri's macOS updater swaps the `.app` bundle. On modern macOS, if the app is **completely unsigned**, the OS can refuse to launch the replaced bundle. The practical fix is **ad-hoc signing** (`codesign -s -` / Tauri does this automatically when no identity is configured) — this is free, requires no Apple account, and is enough for the updater to relaunch. It does **not** remove the first-download Gatekeeper warning, but it keeps updates functional.
- Apple Silicon vs Intel are separate targets (`darwin-aarch64`, `darwin-x86_64`). Simplest is to ship a **universal** build (`--target universal-apple-darwin`) so one artifact covers both.
- Real fix later: Apple Developer Program ($99/yr) → Developer ID signing + notarization removes all warnings. Not blocking.

**Bottom line:** updates work on both platforms without certs. The only thing we're trading away is a clean first-install experience.

---

## Hosting options

| Option | Cost | Notes |
|---|---|---|
| **GitHub Releases** (recommended start) | Free | Public repo → public download URLs. Dead simple with `tauri-action`. Manifest can be a static `latest.json` asset, or point endpoints at the `latest` release. |
| **Cloudflare R2** (we have CF) | ~Free at our scale | Private bucket + public custom domain. Good if we don't want artifacts publicly attached to GitHub. Upload artifacts + `latest.json` in CI. |
| Dynamic update server (CF Worker) | Low | Only needed for staged rollouts / channels / per-user gating. Overkill for v1. |

The updater `endpoints` support template vars: `{{target}}`, `{{arch}}`, `{{current_version}}` — useful later for a dynamic server; not needed for static hosting.

---

## Implementation plan (concrete)

### 1. Add dependencies
```toml
# src-tauri/Cargo.toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"   # for relaunch after install
```
```jsonc
// package.json (web app)
"@tauri-apps/plugin-updater": "^2",
"@tauri-apps/plugin-process": "^2"
```

### 2. Generate the updater keypair (one time, keep private key in a vault)
```bash
bun run tauri signer generate -- -w ~/.tauri/nightcore-updater.key
# -> nightcore-updater.key (PRIVATE — secret), nightcore-updater.key.pub (public)
```
- Private key + its password → **GitHub Actions secrets** (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
- Public key → committed in `tauri.conf.json`. **Losing the private key = can never push updates to installed apps**, so back it up.

### 3. Configure `tauri.conf.json`
```jsonc
{
  "version": "0.1.0",            // <-- real semver, replace "0.0.0"
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "<contents of nightcore-updater.key.pub>",
      "endpoints": [
        "https://github.com/Shironex/nightcore/releases/latest/download/latest.json"
      ],
      "windows": { "installMode": "passive" }  // progress bar, minimal interaction
    }
  }
}
```

### 4. Permissions — `capabilities/default.json`
```jsonc
"permissions": [
  "core:default", "dialog:allow-open", "notification:default",
  "updater:default",        // allow-check / download / install
  "process:allow-restart"
]
```

### 5. Register plugins — `src-tauri/src/lib.rs`
```rust
.plugin(tauri_plugin_process::init())
.setup(|app| {
    #[cfg(desktop)]
    app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
    // ... existing setup
})
```

### 6. Frontend check flow (web app)
```ts
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

const update = await check()
if (update) {
  // show "vX.Y.Z available" UI with update.notes
  await update.downloadAndInstall((e) => { /* progress events */ })
  await relaunch()
}
```
- Recommended UX: check on startup (after a short delay) + a manual "Check for updates" in Settings. Show release notes, let the user defer. Don't force-restart mid-task — Nightcore runs long agent loops, so gate the relaunch on task state.

### 7. The `latest.json` manifest (generated in CI)
```jsonc
{
  "version": "0.1.0",
  "notes": "…",
  "pub_date": "2026-06-21T10:30:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "<.sig contents>", "url": "https://github.com/Shironex/nightcore/releases/download/v0.1.0/Nightcore_0.1.0_x64-setup.exe" },
    "darwin-aarch64": { "signature": "<.sig contents>", "url": "https://github.com/Shironex/nightcore/releases/download/v0.1.0/Nightcore_universal.app.tar.gz" },
    "darwin-x86_64":  { "signature": "<.sig contents>", "url": "<same universal .app.tar.gz>" }
  }
}
```

### 8. CI/CD — `.github/workflows/release.yml` (not yet built; `.github/` now has `ci.yml` + `audit.yml`)
Use **`tauri-apps/tauri-action`**, which builds per-OS on a matrix (macOS runner for `.app`, Windows runner for `.exe`), signs with the env secrets, creates the GitHub Release, and **auto-generates `latest.json`** when `createUpdaterArtifacts` is on.
- Matrix: `macos-latest` (build `universal-apple-darwin`) + `windows-latest`.
- Secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `GITHUB_TOKEN`.
- Trigger on tag push (`v*`) — ties cleanly into the existing `/release` skill that bumps `tauri.conf.json` version + tags.

---

## Key decisions to make before building

1. **Hosting:** GitHub Releases (public, zero-setup) vs Cloudflare R2 (private artifacts, custom domain).
2. **macOS scope:** ship now with ad-hoc signing + Gatekeeper warning, or hold mac until we get an Apple Developer cert ($99/yr) for a clean experience?
3. **Update UX:** silent background download + prompt to restart, vs explicit "check & install" in Settings only. (Important given long-running agent tasks — must not relaunch mid-task.)
4. **Versioning trigger:** wire releases to the existing `/release` skill + a `v*` tag → CI. App version is `0.0.0` today and must move to real semver for any of this to function.

## Open gotchas / notes
- App version `0.0.0` means the updater can't compare anything meaningful yet — first real release must set a proper semver baseline.
- Private updater key is single-point-of-failure for the whole update channel — back it up offline + in CI secrets.
- Windows `installMode: "passive"` is the least-annoying default; `"quiet"` is fully silent but hides failures.
- macOS universal build doubles build size but halves release/manifest complexity (one artifact for both arches).
- This is independent of OS signing — we can add Authenticode / Apple notarization **later** without changing the updater wiring at all.

## Primary sources
- Tauri v2 Updater plugin: https://tauri.app/plugin/updater/
- Tauri v2 Windows code signing (SmartScreen guidance): https://v2.tauri.app/distribute/sign/windows/
- `tauri-action` (CI): https://github.com/tauri-apps/tauri-action
