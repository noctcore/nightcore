//! The partial-update wire type ([`TaskPatch`]) and the apply logic that folds a
//! patch's present fields onto a [`Task`].
//!
//! Split out of [`super::model`] (the `Task` data model) so the sparse-update
//! conditionals and their focused tests don't inflate the surface a reader must
//! scan to understand the `Task` contract. Mirrors the existing
//! `settings/{model,patch,store}` split. `TaskPatch` carries a `ts-rs` derive under
//! `cfg(test)`, so the Rust→TS codegen (`cargo test`) still regenerates
//! `TaskPatch.ts` from it — every `#[ts(...)]` / `#[serde(...)]` attribute and the
//! field order is load-bearing.

use serde::Deserialize;

#[cfg(test)]
use ts_rs::TS;

// The `Task` the patch applies onto, plus the enums its fields carry. The
// `PermissionMode` vocabulary is named ONLY by the cfg(test) ts-rs `#[ts(as = …)]`
// narrowing on `permission_mode`, so it is a test-only import.
#[cfg(test)]
use super::model::PermissionMode;
use super::model::{RunMode, Task, TaskKind, TaskStatus};

/// A partial update to a task — every field optional so the webview can patch
/// just what changed. Absent fields are left untouched.
// The web CONSTRUCTS this patch and only ever sends the keys it changed, so every
// field is an OPTIONAL key in TS (`field?`), not a required `field: T | null`.
// `#[ts(optional)]` ⇒ `field?: T`; `#[ts(optional = nullable)]` ⇒ `field?: T | null`
// (matching the prior hand-mirror exactly, including the `model`/`effort` etc.
// fields the bridge declared as nullable-optional). ts-rs derives `TS` without a
// `Serialize` impl, so deserialize-only patch types still export.
#[derive(Debug, Default, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TaskPatch.ts"))]
pub struct TaskPatch {
    #[cfg_attr(test, ts(optional))]
    pub title: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub description: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub status: Option<TaskStatus>,
    #[cfg_attr(test, ts(optional))]
    pub dependencies: Option<Vec<String>>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub model: Option<String>,
    /// M4.7 §E: per-task reasoning effort, set from the create/edit picker.
    #[cfg_attr(test, ts(optional = nullable))]
    pub effort: Option<String>,
    /// M4.7 §A4: per-task permission-mode override, set from the create/edit picker.
    #[cfg_attr(test, ts(optional = nullable, as = "Option<PermissionMode>"))]
    pub permission_mode: Option<String>,
    /// M4: the task kind, set from the create/edit picker.
    #[cfg_attr(test, ts(optional))]
    pub kind: Option<TaskKind>,
    /// M4.6: the run mode, editable pre-run from the create/edit picker.
    #[cfg_attr(test, ts(optional))]
    pub run_mode: Option<RunMode>,
    /// SDK-guardrails: per-task max-turns override, editable pre-run.
    #[cfg_attr(test, ts(optional = nullable))]
    pub max_turns: Option<u32>,
    /// SDK-guardrails: per-task max-budget-USD override, editable pre-run.
    #[cfg_attr(test, ts(optional = nullable))]
    pub max_budget_usd: Option<f64>,
    /// The verify-command contract: a machine-checkable done-command run as a
    /// Structure-Lock check before the reviewer. Editable pre-run from the create/edit
    /// picker (and set by a Harness proposal-convert that wires enforcement).
    #[cfg_attr(test, ts(optional = nullable))]
    pub verify_command: Option<String>,
}

impl TaskPatch {
    /// Apply the present fields of this patch onto `task`; absent fields are left
    /// untouched. `updated_at` is bumped by the store on persist, not here.
    pub fn apply(self, task: &mut Task) {
        if let Some(title) = self.title {
            task.title = title;
        }
        if let Some(description) = self.description {
            task.description = description;
        }
        if let Some(status) = self.status {
            task.status = status;
        }
        if let Some(dependencies) = self.dependencies {
            task.dependencies = dependencies;
        }
        if let Some(kind) = self.kind {
            task.kind = kind;
        }
        if let Some(run_mode) = self.run_mode {
            task.run_mode = run_mode;
        }
        // `model`/`effort`/`permission_mode` are themselves `Option`, so serde
        // flattens an absent field and an explicit `null` to the same `None`. A
        // patch can therefore SET each but not clear it; an absent/null value is
        // left untouched (same semantics as `model`).
        if self.model.is_some() {
            task.model = self.model;
        }
        if self.effort.is_some() {
            task.effort = self.effort;
        }
        if self.permission_mode.is_some() {
            task.permission_mode = self.permission_mode;
        }
        // Autonomy ceilings follow the same `Option`-set-not-clear semantics as
        // `model`/`effort`: a present value sets the override; absent/null leaves
        // it untouched (inherit the config default at launch).
        if self.max_turns.is_some() {
            task.max_turns = self.max_turns;
        }
        if self.max_budget_usd.is_some() {
            task.max_budget_usd = self.max_budget_usd;
        }
        if self.verify_command.is_some() {
            task.verify_command = self.verify_command;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_sets_run_mode_when_present() {
        let mut task = Task::new("t".into(), String::new());
        assert_eq!(task.run_mode, RunMode::Main);
        let patch: TaskPatch = serde_json::from_str(r#"{"runMode":"worktree"}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.run_mode, RunMode::Worktree);
    }

    #[test]
    fn patch_sets_kind_when_present() {
        let mut task = Task::new("t".into(), String::new());
        assert_eq!(task.kind, TaskKind::Build);
        let patch: TaskPatch = serde_json::from_str(r#"{"kind":"research"}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.kind, TaskKind::Research);
    }

    #[test]
    fn patch_applies_only_present_fields() {
        let mut task = Task::new("orig".into(), "orig-desc".into());
        let patch = TaskPatch {
            title: Some("new".into()),
            status: Some(TaskStatus::Ready),
            ..Default::default()
        };
        patch.apply(&mut task);

        assert_eq!(task.title, "new");
        assert_eq!(task.status, TaskStatus::Ready);
        // Untouched fields keep their original values.
        assert_eq!(task.description, "orig-desc");
        assert!(task.dependencies.is_empty());
    }

    #[test]
    fn patch_sets_effort_and_permission_mode_when_present() {
        let mut task = Task::new("t".into(), String::new());
        let patch: TaskPatch =
            serde_json::from_str(r#"{"effort":"high","permissionMode":"ask"}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.effort.as_deref(), Some("high"));
        assert_eq!(task.permission_mode.as_deref(), Some("ask"));

        // An absent field leaves the prior value untouched (same as `model`).
        let absent: TaskPatch = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        absent.apply(&mut task);
        assert_eq!(task.effort.as_deref(), Some("high"));
        assert_eq!(task.permission_mode.as_deref(), Some("ask"));
    }

    #[test]
    fn patch_sets_guardrail_ceilings_when_present() {
        let mut task = Task::new("t".into(), String::new());
        let patch: TaskPatch =
            serde_json::from_str(r#"{"maxTurns":10,"maxBudgetUsd":1.5}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.max_turns, Some(10));
        assert_eq!(task.max_budget_usd, Some(1.5));

        // An absent field leaves the prior override untouched (same as `model`).
        let absent: TaskPatch = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        absent.apply(&mut task);
        assert_eq!(task.max_turns, Some(10));
        assert_eq!(task.max_budget_usd, Some(1.5));
    }

    #[test]
    fn patch_sets_verify_command_when_present() {
        let mut task = Task::new("t".into(), String::new());
        assert!(task.verify_command.is_none());
        let patch: TaskPatch = serde_json::from_str(r#"{"verifyCommand":"npx eslint ."}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.verify_command.as_deref(), Some("npx eslint ."));

        // An absent field leaves the prior value untouched (same set-not-clear as `model`).
        let absent: TaskPatch = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        absent.apply(&mut task);
        assert_eq!(task.verify_command.as_deref(), Some("npx eslint ."));
    }

    #[test]
    fn patch_sets_model_when_present() {
        let mut task = Task::new("t".into(), String::new());
        assert!(task.model.is_none());
        let patch: TaskPatch = serde_json::from_str(r#"{"model":"claude-opus-4-8"}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.model.as_deref(), Some("claude-opus-4-8"));
    }

    #[test]
    fn patch_leaves_model_untouched_when_absent() {
        // `Option<String>` flattens an explicit `null` and an absent field to the
        // same `None`, so a patch can SET a model but cannot distinguish "clear
        // it" from "don't touch it" — an absent (or null) `model` is a no-op.
        let mut task = Task::new("t".into(), String::new());
        task.model = Some("claude-opus-4-8".into());

        let absent: TaskPatch = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        absent.apply(&mut task);
        assert_eq!(task.model.as_deref(), Some("claude-opus-4-8"));

        let explicit_null: TaskPatch = serde_json::from_str(r#"{"model":null}"#).unwrap();
        explicit_null.apply(&mut task);
        assert_eq!(
            task.model.as_deref(),
            Some("claude-opus-4-8"),
            "explicit null is indistinguishable from absent; model is unchanged"
        );
    }

    #[test]
    fn patch_deserializes_camel_case_keys() {
        let patch: TaskPatch =
            serde_json::from_str(r#"{"status":"in_progress","dependencies":["a"]}"#).unwrap();
        assert_eq!(patch.status, Some(TaskStatus::InProgress));
        assert_eq!(patch.dependencies, Some(vec!["a".to_string()]));
        assert!(patch.title.is_none());
    }
}
