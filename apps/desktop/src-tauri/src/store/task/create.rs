//! The create-time overrides ([`CreateInputs`]) and the default-stamping task
//! builder ([`build_new_task`]).
//!
//! Split out of [`super::model`] so the settings-resolution / defaults plumbing —
//! and its `SettingsStore`-backed tests — stay out of the `Task` data-model file.
//! Mirrors the existing `settings/{model,patch,store}` split. Everything here is
//! `pub(crate)`: the create path (`commands::task`, `crud::convert_one`) is the only
//! caller.

use super::model::{RunMode, Task, TaskKind};

/// The optional create-time overrides for a new task. Each `None` field falls
/// back to the resolved Settings default (per-project override → global → the
/// engine's `@nightcore/config` default).
#[derive(Debug, Default)]
pub(crate) struct CreateInputs {
    /// M4: the kind picked in the create dialog. `None` ⇒ the `Build` default
    /// (`TaskKind::default()`), preserving the pre-M4 create shape.
    pub(crate) kind: Option<TaskKind>,
    pub(crate) run_mode: Option<RunMode>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) permission_mode: Option<String>,
    pub(crate) max_turns: Option<u32>,
    pub(crate) max_budget_usd: Option<f64>,
    /// Worktree branch name chosen in the branch picker (worktree mode). `None` ⇒
    /// the coordinator names it `nc/<taskId>` at submit.
    pub(crate) branch: Option<String>,
    /// Base branch chosen in the branch picker (worktree mode). `None` ⇒ the
    /// project's current branch at allocate/merge time.
    pub(crate) base_branch: Option<String>,
}

/// Build a fresh backlog task, stamping the resolved Settings defaults for any
/// field the create call left unset. Factored out of [`create_task`] so the
/// default-resolution is unit-testable without an `AppHandle`.
///
/// Resolution order per field: explicit create input → Settings (per-project
/// override → global). `model`/`effort`/`run_mode` always end up concrete (Settings
/// has a non-optional default for them). The guardrail ceilings stay `None` when
/// Settings has no value either, so the engine's `@nightcore/config` default
/// (maxTurns 200, budget uncapped) applies at launch.
pub(crate) fn build_new_task(
    settings: &crate::settings::SettingsStore,
    pid: Option<&str>,
    title: String,
    description: String,
    inputs: CreateInputs,
) -> Task {
    let run_mode = inputs
        .run_mode
        .unwrap_or_else(|| settings.default_run_mode(pid));
    let mut task = Task::new(title, description).with_run_mode(run_mode);
    // M4: stamp the picked kind (Build default when the create call omits it) so a
    // Decompose/Research/TDD selection in the dialog survives create — without this,
    // every new task fell back to `TaskKind::default()` regardless of the picker.
    task.kind = inputs.kind.unwrap_or_default();
    // Branch picker (worktree mode only): a chosen branch name / base branch survive
    // create so the coordinator allocates the worktree off the right base under the
    // chosen name. Blank entries fall back to the defaults (`nc/<taskId>` off the
    // project's current branch). Main-mode tasks never carry a worktree branch.
    if run_mode.is_worktree() {
        // A blank picker entry falls back to the default naming; so does one that
        // isn't a legal git ref (e.g. a name git would parse as an OPTION), so a
        // hostile/typo'd branch can never be stored and later spliced into a git
        // argument list. `worktree::allocate_branch`/`merge_branch` re-validate at the
        // call boundary, so this is the ingestion half of a defence-in-depth pair.
        task.branch = inputs
            .branch
            .filter(|b| !b.trim().is_empty())
            .filter(|b| crate::worktree::validate_ref(b).is_ok());
        task.base_branch = inputs
            .base_branch
            .filter(|b| !b.trim().is_empty())
            .filter(|b| crate::worktree::validate_ref(b).is_ok());
    }
    // P0: an explicit per-task model/effort wins; absent ⇒ stamp the resolved
    // Settings default (an SDK long id) so changing "Default model" in Settings
    // actually affects new runs. `permission_mode` stays lazily resolved at launch
    // (`resolve_permission_mode`), so `None` here means "inherit".
    task.model = Some(inputs.model.unwrap_or_else(|| settings.default_model(pid)));
    task.effort = Some(
        inputs
            .effort
            .unwrap_or_else(|| settings.default_effort(pid)),
    );
    task.permission_mode = inputs.permission_mode;
    // SDK-guardrails: an explicit per-task ceiling wins; absent ⇒ stamp the
    // resolved Settings default (per-project override → global), so the Settings
    // "Limits" knob is authoritative for a new task. When Settings has no ceiling
    // either, this stays `None` and the engine's `@nightcore/config` default
    // applies at launch — same resolution shape as `model`/`effort`/`run_mode`.
    task.max_turns = inputs.max_turns.or_else(|| settings.default_max_turns(pid));
    task.max_budget_usd = inputs
        .max_budget_usd
        .or_else(|| settings.default_max_budget_usd(pid));
    task
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_new_task_inherits_guardrails_from_settings_when_unset() {
        use crate::settings::SettingsStore;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let settings = SettingsStore::load_from(tmp.path().join("config"));
        // A global Settings ceiling is set; the project has its own tighter override.
        settings
            .update_for_test(
                serde_json::from_str(r#"{"maxTurns":150,"maxBudgetUsd":9.0}"#).unwrap(),
            )
            .expect("global ceiling");
        settings
            .update_for_test(serde_json::from_str(r#"{"projectId":"p1","maxTurns":50}"#).unwrap())
            .expect("project override");

        // No explicit per-task ceilings → stamp the resolved Settings defaults.
        let task = build_new_task(
            &settings,
            Some("p1"),
            "t".into(),
            String::new(),
            CreateInputs::default(),
        );
        assert_eq!(
            task.max_turns,
            Some(50),
            "per-project override wins for max_turns"
        );
        assert_eq!(
            task.max_budget_usd,
            Some(9.0),
            "max_budget_usd has no project override → global"
        );

        // Another project with no override falls back to the global ceiling.
        let other = build_new_task(
            &settings,
            Some("other"),
            "t".into(),
            String::new(),
            CreateInputs::default(),
        );
        assert_eq!(other.max_turns, Some(150));
        assert_eq!(other.max_budget_usd, Some(9.0));
    }

    #[test]
    fn build_new_task_explicit_ceilings_win_over_settings() {
        use crate::settings::SettingsStore;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let settings = SettingsStore::load_from(tmp.path().join("config"));
        settings
            .update_for_test(
                serde_json::from_str(r#"{"maxTurns":150,"maxBudgetUsd":9.0}"#).unwrap(),
            )
            .expect("global ceiling");

        // An explicit per-task value always overrides the Settings default.
        let task = build_new_task(
            &settings,
            None,
            "t".into(),
            String::new(),
            CreateInputs {
                max_turns: Some(7),
                max_budget_usd: Some(0.5),
                ..Default::default()
            },
        );
        assert_eq!(task.max_turns, Some(7));
        assert_eq!(task.max_budget_usd, Some(0.5));
    }

    #[test]
    fn build_new_task_stamps_the_picked_kind() {
        use crate::settings::SettingsStore;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let settings = SettingsStore::load_from(tmp.path().join("config"));

        // An explicit kind from the create dialog survives — this is the bug the
        // create path had: `kind` was never threaded, so every new task became Build.
        let task = build_new_task(
            &settings,
            None,
            "t".into(),
            String::new(),
            CreateInputs {
                kind: Some(TaskKind::Decompose),
                ..Default::default()
            },
        );
        assert_eq!(task.kind, TaskKind::Decompose, "the picked kind is stamped");

        // Omitted kind falls back to the Build default (pre-M4 create shape).
        let defaulted = build_new_task(
            &settings,
            None,
            "t".into(),
            String::new(),
            CreateInputs::default(),
        );
        assert_eq!(
            defaulted.kind,
            TaskKind::Build,
            "an omitted kind defaults to Build"
        );
    }

    #[test]
    fn build_new_task_drops_an_invalid_picker_branch_at_ingestion() {
        use crate::settings::SettingsStore;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let settings = SettingsStore::load_from(tmp.path().join("config"));

        // A picker value git would parse as an OPTION (or is otherwise not a legal
        // ref) is never stored — it falls back to the default naming, so a hostile /
        // typo'd branch can't be persisted and later spliced into a git call.
        let hostile = build_new_task(
            &settings,
            None,
            "t".into(),
            String::new(),
            CreateInputs {
                run_mode: Some(RunMode::Worktree),
                branch: Some("-D".into()),
                base_branch: Some("a b".into()),
                ..Default::default()
            },
        );
        assert!(hostile.branch.is_none(), "an option-like branch is dropped");
        assert!(
            hostile.base_branch.is_none(),
            "a malformed base is dropped"
        );

        // A legal picker branch/base survives ingestion unchanged.
        let ok = build_new_task(
            &settings,
            None,
            "t".into(),
            String::new(),
            CreateInputs {
                run_mode: Some(RunMode::Worktree),
                branch: Some("feature/foo".into()),
                base_branch: Some("main".into()),
                ..Default::default()
            },
        );
        assert_eq!(ok.branch.as_deref(), Some("feature/foo"));
        assert_eq!(ok.base_branch.as_deref(), Some("main"));
    }

    #[test]
    fn build_new_task_leaves_guardrails_none_when_settings_unset() {
        use crate::settings::SettingsStore;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let settings = SettingsStore::load_from(tmp.path().join("config"));
        // No Settings ceiling and no explicit input → None, so the engine's config
        // default (maxTurns 200, budget uncapped) applies at launch.
        let task = build_new_task(
            &settings,
            None,
            "t".into(),
            String::new(),
            CreateInputs::default(),
        );
        assert!(task.max_turns.is_none());
        assert!(task.max_budget_usd.is_none());
        // The P0 model/effort defaults are still stamped concretely.
        assert_eq!(task.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(task.effort.as_deref(), Some("medium"));
    }
}
