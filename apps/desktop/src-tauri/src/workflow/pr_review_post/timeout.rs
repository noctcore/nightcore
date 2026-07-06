//! The shared PR-review `gh` wall-clock bound.
//!
//! Lifted out of `mod.rs` into a sibling so the module stays a manifest (issue #17
//! phase D). The `diff` + `post` submodules reach it as `super::GH_TIMEOUT` via the
//! private re-binding in `mod.rs`.

use std::time::Duration;

/// Wall-clock bound on every network-facing PR-review `gh` spawn (diff fetch + post).
/// Same rationale as the create/status bounds: generous but finite — a black-holed
/// GitHub must error out, not pin the blocking thread.
pub(super) const GH_TIMEOUT: Duration = Duration::from_secs(120);
