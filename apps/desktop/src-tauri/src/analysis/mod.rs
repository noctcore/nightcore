//! Pure-compute analysis & generation subsystems — a top-level peer of `store/`,
//! deliberately kept OUT of it.
//!
//! `store/` is the persistence leaf (on-disk registries, path safety, structure
//! lock). The modules here hold zero persistence: they read a project's sources
//! and derive something.
//!
//! - [`repo_map`] — deterministic tree-sitter + PageRank ranked repo-map generator.
//! - [`context`] — Pre-flight Context Pack assembler (embeds the repo map).
//! - [`injection_scan`] — prompt-injection surface scan over git-tracked text.
//!
//! Splitting these out keeps the layer's name predictive of its contents and
//! sharpens the "store is a leaf" boundary that other layering reasoning depends
//! on. These modules may reach DOWN into `store/` (e.g. `store::write_atomic`,
//! `store::project`); nothing reaches back up into them from `store/`.

pub(crate) mod context;
pub(crate) mod injection_scan;
pub(crate) mod repo_map;
