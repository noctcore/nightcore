//! Cross-cutting infrastructure: process-wide logging setup and the platform
//! command resolver. Grouped here so the crate root holds only the module tree;
//! the historical `crate::{logging, platform}` paths are preserved by the facade
//! re-exports in `lib.rs`.

pub(crate) mod logging;
pub(crate) mod platform;
