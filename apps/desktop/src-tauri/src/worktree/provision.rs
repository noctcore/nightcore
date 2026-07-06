//! Worktree dependency provisioning: install a worktree's JS/TS dependencies so an
//! in-worktree readiness gauntlet (`tsc -b`, `lint`, `test`) can resolve them.
//!
//! **Why this exists.** A fresh `git worktree add` checks out the *tracked* files
//! only — `node_modules` is gitignored, so the worktree has none of its own. Most
//! dependencies hoist to the MAIN checkout's root `node_modules` and Node's upward
//! module resolution finds them there. But **non-hoisted, package-local** deps
//! (bun/npm place these under `<pkg>/node_modules` in the main checkout, e.g. a
//! version-pinned `@anthropic-ai/claude-agent-sdk` symlinked into
//! `packages/engine/node_modules`) are invisible to the worktree: resolution from
//! `<worktree>/<pkg>/src/…` walks up past the worktree root straight to
//! `<repo>/node_modules`, never touching the real `<repo>/<pkg>/node_modules`. So
//! `tsc -b` fails with `error TS2307: Cannot find module …` (exit 2) — with the
//! whole downstream cascade of `implicitly has an 'any' type` errors — even though
//! the branch itself is fine. That is the empirical PR-blocker this fixes (a
//! worktree on a known-good commit that passes at the repo root failed the gauntlet
//! purely because the SDK types were unresolvable inside the worktree).
//!
//! **The fix.** Before an in-worktree gauntlet runs, install the worktree's OWN
//! `node_modules` from the committed lockfile (`--frozen-lockfile` / `npm ci`), so
//! the package-local symlinks exist inside the worktree and resolution succeeds.
//! Deterministic by construction — a frozen install reproduces exactly the tree the
//! lockfile pins, never mutating it. Cheap in practice: the package manager reuses
//! its global content cache, so a warm install is well under a second.
//!
//! **Scope.** A no-op when there is nothing to install *deterministically*: a
//! non-JS project (no `package.json`), or a JS project with no recognized lockfile
//! (we never invent an install — the gauntlet then runs with the prior
//! upward-resolution behavior). We never skip the gauntlet itself.

use std::path::Path;

/// The frozen/deterministic install command for a worktree's detected JS lockfile,
/// or `None` when there is nothing to install deterministically (no `package.json`,
/// or no recognized lockfile). Precedence matches the readiness gauntlet's package
/// manager detection (`detect.rs`): bun wins when a bun lockfile is present.
fn install_command(dir: &Path) -> Option<(&'static str, &'static [&'static str])> {
    if !dir.join("package.json").exists() {
        return None;
    }
    if dir.join("bun.lock").exists() || dir.join("bun.lockb").exists() {
        Some(("bun", &["install", "--frozen-lockfile"]))
    } else if dir.join("pnpm-lock.yaml").exists() {
        Some(("pnpm", &["install", "--frozen-lockfile"]))
    } else if dir.join("yarn.lock").exists() {
        Some(("yarn", &["install", "--frozen-lockfile"]))
    } else if dir.join("package-lock.json").exists() {
        Some(("npm", &["ci"]))
    } else {
        None
    }
}

/// Install a worktree's JS dependencies from its committed lockfile so an
/// in-worktree gauntlet can resolve package-local (non-hoisted) deps. A no-op for a
/// non-JS project and for a JS project without a recognized lockfile. Deterministic
/// (frozen install — never rewrites the lockfile).
///
/// Errors (with the install command + a tail of its output) rather than letting the
/// gauntlet fail later with a cryptic `Cannot find module …`: an install we can't
/// complete is the real reason the checks would be meaningless, so it is surfaced
/// as its own explained failure. Callers run this immediately BEFORE the gauntlet.
pub fn provision_deps(dir: &Path) -> Result<(), String> {
    let Some((program, args)) = install_command(dir) else {
        return Ok(()); // nothing to install deterministically
    };
    tracing::info!(
        target: "nightcore::worktree",
        dir = %dir.display(),
        program,
        "provisioning worktree dependencies for the gauntlet"
    );
    // Route the bare program name through the platform resolver so it launches
    // through Windows shims (`bun.cmd`/`npm.cmd`) exactly like the gauntlet does.
    let output = crate::platform::std_command(program)
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| {
            format!(
                "failed to launch `{program} {}` to provision worktree dependencies \
                 (is `{program}` on PATH?): {e}",
                args.join(" ")
            )
        })?;
    if output.status.success() {
        return Ok(());
    }
    let code = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string());
    let tail = crate::infra::text::tail_output(&output.stdout, &output.stderr);
    Err(format!(
        "failed to install worktree dependencies (`{program} {}` exited {code}) — \
         the readiness gauntlet can't run without them:\n{tail}",
        args.join(" ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), "{}").expect("write fixture file");
    }

    #[test]
    fn no_package_json_is_a_noop() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        assert!(install_command(tmp.path()).is_none());
        // provision_deps must succeed (nothing to do) on a non-JS project.
        assert!(provision_deps(tmp.path()).is_ok());
    }

    #[test]
    fn package_json_without_a_lockfile_is_a_noop() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        touch(tmp.path(), "package.json");
        // No recognized lockfile ⇒ nothing to install deterministically ⇒ no-op
        // (we never invent an install), so the gauntlet's prior behavior stands.
        assert!(install_command(tmp.path()).is_none());
        assert!(provision_deps(tmp.path()).is_ok());
    }

    #[test]
    fn detects_the_right_frozen_install_per_lockfile() {
        // bun wins the precedence when its lockfile is present.
        let bun = tempfile::TempDir::new().expect("temp dir");
        touch(bun.path(), "package.json");
        touch(bun.path(), "bun.lock");
        touch(bun.path(), "package-lock.json"); // present but out-ranked by bun
        assert_eq!(
            install_command(bun.path()),
            Some(("bun", &["install", "--frozen-lockfile"][..]))
        );

        let pnpm = tempfile::TempDir::new().expect("temp dir");
        touch(pnpm.path(), "package.json");
        touch(pnpm.path(), "pnpm-lock.yaml");
        assert_eq!(
            install_command(pnpm.path()),
            Some(("pnpm", &["install", "--frozen-lockfile"][..]))
        );

        let yarn = tempfile::TempDir::new().expect("temp dir");
        touch(yarn.path(), "package.json");
        touch(yarn.path(), "yarn.lock");
        assert_eq!(
            install_command(yarn.path()),
            Some(("yarn", &["install", "--frozen-lockfile"][..]))
        );

        let npm = tempfile::TempDir::new().expect("temp dir");
        touch(npm.path(), "package.json");
        touch(npm.path(), "package-lock.json");
        assert_eq!(install_command(npm.path()), Some(("npm", &["ci"][..])));
    }
}
