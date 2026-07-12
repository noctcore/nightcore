//! Cross-cutting infrastructure: process-wide logging setup, the platform
//! command resolver, and the deadline-bounded child wait. Grouped here so the
//! crate root holds only the module tree; the historical
//! `crate::{logging, platform, proc}` paths are preserved by the facade
//! re-exports in `lib.rs`.

pub(crate) mod browse;
pub(crate) mod editor;
pub(crate) mod logging;
pub(crate) mod path_confine;
pub(crate) mod platform;
pub(crate) mod proc;
pub(crate) mod safe_join;
pub(crate) mod text;
pub(crate) mod time;
pub(crate) mod untrusted;
