//! The project registry — multi-repo support (Phase 2).
//!
//! Nightcore points at a git repo at a time. The registry of known projects, plus
//! which one is active, lives in Tauri's **app config dir** (not in any single
//! repo): `projects.json` (the `Vec<Project>` registry) and `active.json`
//! (`{ activeProjectId }`). Per-project **tasks** stay where M1 put them, under
//! `<project.path>/.nightcore/tasks/` — activating a project retargets the
//! [`TaskStore`](crate::store::TaskStore) there.
//!
//! Held in managed Tauri state; commands take it as `State<'_, ProjectStore>`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

/// A known project: a git repo Nightcore can drive. Field names mirror the
/// Phase 2 contract and serialize camelCase for the TS bridge and on-disk JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "Project.ts"))]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Absolute repo path.
    pub path: String,
    /// Current git branch, best-effort (`None` if it can't be resolved).
    pub branch: Option<String>,
    /// ISO8601 creation time.
    pub created_at: String,
    /// ISO8601 of the last activation, or `None` if never activated.
    pub last_active_at: Option<String>,
    /// Lucide export name for a preset icon (e.g. `"FolderCode"`). Serde-additive:
    /// legacy registry entries load as `None`.
    #[serde(default)]
    pub icon: Option<String>,
    /// Repo-relative path to a custom image under `.nightcore/images/`. Serde-additive.
    #[serde(default)]
    pub custom_icon_path: Option<String>,
}

impl Project {
    pub(crate) fn new(name: String, path: String, branch: Option<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            path,
            branch,
            created_at: now_iso8601(),
            last_active_at: None,
            icon: None,
            custom_icon_path: None,
        }
    }
}

/// The persisted `active.json` shape: which project is currently active.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveState {
    active_project_id: Option<String>,
}

/// The in-memory registry plus the config dir it persists to.
pub struct ProjectStore {
    projects: Mutex<Vec<Project>>,
    active_id: Mutex<Option<String>>,
    /// App config dir holding `projects.json` / `active.json`.
    pub(crate) config_dir: PathBuf,
}

impl ProjectStore {
    /// Load the registry from `<config_dir>/projects.json` and the active id from
    /// `active.json`, creating the dir if missing. Unparsable files start empty.
    pub fn load_from(config_dir: PathBuf) -> Self {
        if let Err(e) = std::fs::create_dir_all(&config_dir) {
            tracing::warn!(target: "nightcore::project", dir = %config_dir.display(), error = %e, "failed to create project config dir");
        }
        let projects = read_json(&config_dir.join("projects.json")).unwrap_or_default();
        let active: ActiveState = read_json(&config_dir.join("active.json")).unwrap_or_default();
        Self {
            projects: Mutex::new(projects),
            active_id: Mutex::new(active.active_project_id),
            config_dir,
        }
    }

    /// Snapshot of all known projects (registry order).
    pub fn list(&self) -> Vec<Project> {
        crate::sync::lock_or_recover(&self.projects).clone()
    }

    /// The active project, if one is set and still in the registry.
    pub fn active(&self) -> Option<Project> {
        let id = crate::sync::lock_or_recover(&self.active_id).clone()?;
        crate::sync::lock_or_recover(&self.projects)
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    /// The tasks dir for the currently-active project, or `None` with no active
    /// project. The [`TaskStore`](crate::store::TaskStore) is retargeted here on activation.
    pub fn active_tasks_dir(&self) -> Option<PathBuf> {
        self.active().map(|p| tasks_dir_for(&p.path))
    }

    /// The runs dir (`<project>/.nightcore/<slug>`) for the active project's given
    /// scan kind, or `None` with no active project. The matching `RunStore` is
    /// retargeted here on activation. `slug` is the kind's dir name (`insights` /
    /// `harness` / `scorecards`), driven off the single `scan_kinds!` registry so a
    /// new scan kind needs no new accessor here.
    pub fn active_scan_dir(&self, slug: &str) -> Option<PathBuf> {
        self.active()
            .map(|p| Path::new(&p.path).join(".nightcore").join(slug))
    }

    pub(crate) fn add(&self, project: Project) -> Result<(), String> {
        crate::sync::lock_or_recover(&self.projects).push(project);
        self.persist_registry()
    }

    pub(crate) fn remove(&self, id: &str) -> Result<bool, String> {
        let removed = {
            let mut guard = crate::sync::lock_or_recover(&self.projects);
            let before = guard.len();
            guard.retain(|p| p.id != id);
            guard.len() != before
        };
        if removed {
            // Clear the active pointer if it referenced the removed project.
            let mut active = crate::sync::lock_or_recover(&self.active_id);
            if active.as_deref() == Some(id) {
                *active = None;
                self.persist_active(&active)?;
            }
            self.persist_registry()?;
        }
        Ok(removed)
    }

    /// Look up a project by id (clone). Errors if unknown.
    pub(crate) fn get(&self, id: &str) -> Result<Project, String> {
        crate::sync::lock_or_recover(&self.projects)
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| format!("no project with id {id}"))
    }

    /// Patch `name` and/or Lucide `icon` on a project. Setting `icon` clears
    /// `custom_icon_path` (the caller removes any on-disk custom file first).
    /// Omitted patch fields are left unchanged. Errors if the id is unknown.
    pub(crate) fn update(
        &self,
        id: &str,
        name: Option<&str>,
        icon: Option<Option<&str>>,
    ) -> Result<Project, String> {
        let project = {
            let mut guard = crate::sync::lock_or_recover(&self.projects);
            let project = guard
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| format!("no project with id {id}"))?;
            if let Some(name) = name {
                project.name = name.to_string();
            }
            if let Some(icon) = icon {
                project.icon = icon.map(str::to_string);
                if icon.is_some() {
                    project.custom_icon_path = None;
                }
            }
            project.clone()
        };
        self.persist_registry()?;
        Ok(project)
    }

    /// Set the custom icon path and clear the Lucide preset. Errors if unknown.
    pub(crate) fn set_custom_icon_path(&self, id: &str, rel: &str) -> Result<Project, String> {
        let project = {
            let mut guard = crate::sync::lock_or_recover(&self.projects);
            let project = guard
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| format!("no project with id {id}"))?;
            project.custom_icon_path = Some(rel.to_string());
            project.icon = None;
            project.clone()
        };
        self.persist_registry()?;
        Ok(project)
    }

    /// Clear both icon fields. Errors if unknown.
    pub(crate) fn clear_icon_fields(&self, id: &str) -> Result<Project, String> {
        let project = {
            let mut guard = crate::sync::lock_or_recover(&self.projects);
            let project = guard
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| format!("no project with id {id}"))?;
            project.icon = None;
            project.custom_icon_path = None;
            project.clone()
        };
        self.persist_registry()?;
        Ok(project)
    }

    /// Rename `id` to `name`, persist the registry, and return the updated
    /// project. The active pointer is unaffected. Errors if the id is unknown.
    pub(crate) fn rename(&self, id: &str, name: &str) -> Result<Project, String> {
        let project = {
            let mut guard = crate::sync::lock_or_recover(&self.projects);
            let project = guard
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| format!("no project with id {id}"))?;
            project.name = name.to_string();
            project.clone()
        };
        self.persist_registry()?;
        Ok(project)
    }

    /// Mark `id` active, bump its `lastActiveAt`, and persist both files. Returns
    /// the updated project. Errors if the id is unknown.
    pub(crate) fn set_active(&self, id: &str) -> Result<Project, String> {
        let project = {
            let mut guard = crate::sync::lock_or_recover(&self.projects);
            let project = guard
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| format!("no project with id {id}"))?;
            project.last_active_at = Some(now_iso8601());
            project.clone()
        };
        {
            let mut active = crate::sync::lock_or_recover(&self.active_id);
            *active = Some(id.to_string());
            self.persist_active(&active)?;
        }
        self.persist_registry()?;
        Ok(project)
    }

    fn persist_registry(&self) -> Result<(), String> {
        let projects = crate::sync::lock_or_recover(&self.projects);
        write_json(&self.config_dir.join("projects.json"), &*projects)
    }

    fn persist_active(&self, active_id: &Option<String>) -> Result<(), String> {
        let state = ActiveState {
            active_project_id: active_id.clone(),
        };
        write_json(&self.config_dir.join("active.json"), &state)
    }
}

/// The tasks dir for a project path: `<path>/.nightcore/tasks`.
fn tasks_dir_for(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".nightcore/tasks")
}

/// Read + deserialize a JSON file, returning `None` on any error (missing,
/// unreadable, or unparsable) so a corrupt file never aborts startup.
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(value) => Some(value),
        Err(e) => {
            // projects.json / active.json are single-file all-or-nothing registries:
            // returning None resets to empty, and the next add/remove/set-active write
            // overwrites the file — losing the entire known-project list. Quarantine the
            // bad file first so the data is recoverable instead of silently erased.
            match crate::store::quarantine_corrupt(path) {
                Ok(backup) => {
                    tracing::warn!(target: "nightcore::project", path = %path.display(), backup = %backup.display(), error = %e, "cannot parse project file; quarantined it and starting empty")
                }
                Err(rename_err) => {
                    tracing::error!(target: "nightcore::project", path = %path.display(), error = %e, rename_error = %rename_err, "cannot parse project file and failed to quarantine it; it may be overwritten on next save")
                }
            }
            None
        }
    }
}

/// Pretty-print a value to a JSON file (write-through persistence). Atomic
/// temp-file + rename (data-integrity #3): a crash/concurrent reader never sees a
/// half-written registry/active file.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    crate::store::write_atomic(path, json.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Current time as an ISO8601 / RFC3339 UTC string, without pulling in `chrono`:
/// epoch seconds formatted by hand. Good enough for a "created at" timestamp.
fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_iso8601(secs)
}

/// Format epoch seconds as `YYYY-MM-DDTHH:MM:SSZ` (UTC). A small civil-time
/// conversion (Howard Hinnant's algorithm) so we avoid a date dependency.
fn format_iso8601(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let secs_of_day = epoch_secs % 86_400;
    let (hour, min, sec) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );

    // days since 1970-01-01 → civil (y, m, d). See
    // http://howardhinnant.github.io/date_algorithms.html#civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_store() -> (ProjectStore, TempDir) {
        let tmp = TempDir::new().expect("create temp dir");
        let store = ProjectStore::load_from(tmp.path().join("config"));
        (store, tmp)
    }

    #[test]
    fn corrupt_registry_is_quarantined_not_silently_overwritten() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = tmp.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        let registry = config.join("projects.json");
        std::fs::write(&registry, b"{ this is not valid json").unwrap();

        // Loading starts empty (the file can't parse)...
        let store = ProjectStore::load_from(config.clone());
        assert!(store.list().is_empty());

        // ...but the unparsable file must be moved aside, not left in place to be
        // overwritten by an empty registry on the next write.
        assert!(
            !registry.exists(),
            "corrupt projects.json must be quarantined"
        );
        let quarantined: Vec<_> = std::fs::read_dir(&config)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("projects.json.corrupt-")
            })
            .collect();
        assert_eq!(
            quarantined.len(),
            1,
            "exactly one quarantine backup expected"
        );
        assert_eq!(
            std::fs::read_to_string(quarantined[0].path()).unwrap(),
            "{ this is not valid json",
            "the original bytes must be preserved for recovery"
        );
    }

    #[test]
    fn registry_crud_round_trips_through_disk() {
        let (store, tmp) = temp_store();
        assert!(store.list().is_empty());

        let project = Project::new(
            "nightcore".into(),
            "/repo/nightcore".into(),
            Some("main".into()),
        );
        let id = project.id.clone();
        store.add(project).expect("add");
        store.set_active(&id).expect("activate");

        // A second store loading the same config dir reconstructs registry + active.
        let reloaded = ProjectStore::load_from(tmp.path().join("config"));
        assert_eq!(reloaded.list().len(), 1);
        assert_eq!(reloaded.active().expect("active").id, id);
        assert!(
            reloaded.active().unwrap().last_active_at.is_some(),
            "set_active persists lastActiveAt"
        );

        // Removing it drops it from the registry and clears the active pointer.
        assert!(reloaded.remove(&id).expect("remove"));
        let reloaded2 = ProjectStore::load_from(tmp.path().join("config"));
        assert!(reloaded2.list().is_empty());
        assert!(reloaded2.active().is_none());
    }

    #[test]
    fn rename_updates_name_and_round_trips_through_disk() {
        let (store, tmp) = temp_store();
        let project = Project::new("old".into(), "/repo/p".into(), None);
        let id = project.id.clone();
        store.add(project).expect("add");

        let renamed = store.rename(&id, "new").expect("rename");
        assert_eq!(renamed.name, "new");

        let reloaded = ProjectStore::load_from(tmp.path().join("config"));
        assert_eq!(reloaded.list()[0].name, "new", "rename persists to disk");
    }

    #[test]
    fn rename_unknown_id_errors() {
        let (store, _tmp) = temp_store();
        assert!(store.rename("nope", "x").is_err());
    }

    #[test]
    fn project_serializes_camel_case() {
        let project = Project::new("p".into(), "/p".into(), None);
        let value = serde_json::to_value(&project).unwrap();
        let obj = value.as_object().unwrap();
        for key in ["createdAt", "lastActiveAt", "customIconPath"] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }
    }

    #[test]
    fn legacy_project_without_icon_fields_loads_as_none() {
        let legacy = r#"{
            "id": "p1",
            "name": "legacy",
            "path": "/repo/p",
            "branch": null,
            "createdAt": "2021-01-01T00:00:00Z",
            "lastActiveAt": null
        }"#;
        let project: Project = serde_json::from_str(legacy).expect("parse legacy project");
        assert!(project.icon.is_none());
        assert!(project.custom_icon_path.is_none());
    }

    #[test]
    fn update_patches_name_and_icon_and_clears_custom_path() {
        let (store, _tmp) = temp_store();
        let project = Project::new("p".into(), "/repo/p".into(), None);
        let id = project.id.clone();
        store.add(project).expect("add");
        store
            .set_custom_icon_path(&id, ".nightcore/images/x.png")
            .expect("custom");

        let updated = store
            .update(&id, Some("new-name"), Some(Some("FolderCode")))
            .expect("update");
        assert_eq!(updated.name, "new-name");
        assert_eq!(updated.icon.as_deref(), Some("FolderCode"));
        assert!(updated.custom_icon_path.is_none());
    }

    #[test]
    fn active_tasks_dir_follows_the_active_project() {
        let (store, _tmp) = temp_store();
        assert!(
            store.active_tasks_dir().is_none(),
            "no project, no tasks dir"
        );

        let project = Project::new("p".into(), "/repo/p".into(), None);
        let id = project.id.clone();
        store.add(project).expect("add");
        store.set_active(&id).expect("activate");

        assert_eq!(
            store.active_tasks_dir().unwrap(),
            PathBuf::from("/repo/p/.nightcore/tasks")
        );
    }

    #[test]
    fn iso8601_formats_a_known_epoch() {
        // 2021-01-01T00:00:00Z = 1609459200.
        assert_eq!(format_iso8601(1_609_459_200), "2021-01-01T00:00:00Z");
        // The unix epoch itself.
        assert_eq!(format_iso8601(0), "1970-01-01T00:00:00Z");
    }
}
