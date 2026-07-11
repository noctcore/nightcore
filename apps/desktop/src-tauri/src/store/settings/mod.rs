//! Global + per-project settings (Phase 2).
//!
//! Settings live in Tauri's **app config dir** as `settings.json`: global defaults
//! plus a `projectOverrides` map keyed by project id. A patch with no `projectId`
//! shallow-merges into the global block; with a `projectId` it merges into that
//! project's override. The run-shaping fields are now enforced (the M2 auto-loop
//! honors `maxConcurrency`/`cleanupWorktrees`, runs apply the guardrails); only the
//! M3 `notifyOnComplete` toggle still persists without a consumer — the UI keeps it
//! visible and roadmap-badged.
//!
//! Held in managed Tauri state; commands take it as `State<'_, SettingsStore>`.

mod helpers;
mod model;
mod patch;
mod store;

// Module facade: preserve the historical `crate::settings::*` paths after the
// god-file split so call sites elsewhere keep resolving unchanged. The command
// re-export is a glob so the `#[tauri::command]` macro's generated siblings
// (`__cmd__*`, `__tauri_command_name_*`) reach `settings::*` for `generate_handler!`
// (mirrors how `sidecar/mod.rs` re-exports its command submodules).
pub use helpers::*;
pub use store::*;
// The data-type + patch facades are reached through `crate::settings::*` only by the
// ts-rs codegen umbrella (`contracts::ts_bindings`) and the inline tests — both
// `#[cfg(test)]` — so the re-exports look unused in a non-test build. Allow it, the
// same way `sidecar/mod.rs` allows its facade-only re-export.
#[allow(unused_imports)]
pub use model::*;
#[allow(unused_imports)]
pub use patch::*;

// The inline test module reaches the submodule items (including the now-`pub(super)`
// `parse_run_mode`/`write_settings`/`SettingsStore::update`) through the glob
// re-exports above; `HashMap` was a file-level import the tests relied on.
#[cfg(test)]
use std::collections::HashMap;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_store() -> (SettingsStore, TempDir) {
        let tmp = TempDir::new().expect("create temp dir");
        let store = SettingsStore::load_from(tmp.path().join("config"));
        (store, tmp)
    }

    #[cfg(unix)]
    #[test]
    fn settings_file_is_written_owner_only_0600() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().expect("temp dir");
        let path = tmp.path().join("settings.json");
        write_settings(&path, &Settings::default()).expect("write");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        // settings.json holds plaintext MCP secrets — only the owner may read it.
        assert_eq!(
            mode & 0o777,
            0o600,
            "settings.json must be owner-only (0600), got {:o}",
            mode & 0o777
        );
    }

    #[test]
    fn defaults_are_the_contract_values() {
        let s = Settings::default();
        // P0: defaults persist SDK long ids so a new task runs with a valid model.
        assert_eq!(s.default_model, "claude-opus-4-8");
        assert_eq!(s.max_concurrency, 3);
        // M4.7 §A1: bypass is the studio default.
        assert_eq!(s.permission_mode, "bypass");
        // Issue #18: Claude is the shipped default provider.
        assert_eq!(s.provider, "claude");
        assert!(s.cleanup_worktrees);
        assert!(!s.notify_on_complete);
        // T11: awaiting-input notification defaults ON (unlike Done/Failed).
        assert!(s.notify_on_awaiting_input);
        assert!(s.project_overrides.is_empty());
    }

    #[test]
    fn canonical_model_id_maps_legacy_short_ids() {
        // P0: a pre-P0 settings file holds short ids; they resolve to SDK long ids.
        assert_eq!(canonical_model_id("opus-4.8"), "claude-opus-4-8");
        assert_eq!(canonical_model_id("sonnet-4.6"), "claude-sonnet-4-6");
        assert_eq!(canonical_model_id("haiku-4.5"), "claude-haiku-4-5");
        // Already-canonical ids pass through unchanged.
        assert_eq!(canonical_model_id("claude-opus-4-8"), "claude-opus-4-8");
        assert_eq!(
            canonical_model_id("claude-haiku-4-5-20251001"),
            "claude-haiku-4-5-20251001"
        );
        // An unknown custom id is the user's choice — passed through verbatim.
        assert_eq!(canonical_model_id("my-custom-model"), "my-custom-model");
    }

    #[test]
    fn known_model_ids_come_from_the_codegen_enum() {
        use crate::contracts::KnownModel;
        // Issue #18, item 4: the catalog is single-sourced from the contract
        // `KnownModelSchema`. These assertions pin the codegen'd serde renames (a
        // contract rename reds this drift guard) and prove `canonical_model_id` /
        // `Settings::default` derive their long ids from the enum, not literals.
        assert_eq!(known_model_id(KnownModel::ClaudeOpus48), "claude-opus-4-8");
        assert_eq!(
            known_model_id(KnownModel::ClaudeSonnet46),
            "claude-sonnet-4-6"
        );
        assert_eq!(
            known_model_id(KnownModel::ClaudeHaiku45),
            "claude-haiku-4-5"
        );
        assert_eq!(known_model_id(KnownModel::ClaudeFable5), "claude-fable-5");
        // The Claude default is the first known model, single-sourced (not a
        // duplicated literal). `Settings::default` (a `claude`-provider install)
        // derives its `default_model` from the SAME provider-aware resolver.
        assert_eq!(default_model_id("claude"), "claude-opus-4-8");
        assert_eq!(
            Settings::default().default_model,
            default_model_id("claude")
        );
    }

    #[test]
    fn default_model_id_is_provider_aware() {
        // B2 (issue #79/#80): a non-Claude provider must NOT fall through to a Claude
        // model. Claude (and any unrecognized id, which the factory runs on the Claude
        // backend) → the contract default; Codex → the Codex SDK default.
        assert_eq!(default_model_id("claude"), "claude-opus-4-8");
        assert_eq!(
            default_model_id("codex"),
            "gpt-5-codex",
            "Codex must not default to a Claude model"
        );
        // An unknown provider is treated as Claude by the factory (fallback), so a
        // Claude default is correct for it.
        assert_eq!(default_model_id("gemini"), "claude-opus-4-8");
    }

    #[test]
    fn canonical_model_id_passes_foreign_provider_ids_through() {
        // B2: `canonical_model_id` must NOT rewrite a non-Claude id into a Claude enum
        // value — a Codex model id matches no Claude family token and is returned
        // verbatim.
        assert_eq!(canonical_model_id("gpt-5-codex"), "gpt-5-codex");
        assert_eq!(canonical_model_id("o3"), "o3");
        assert_eq!(canonical_model_id(""), "");
    }

    #[test]
    fn default_model_resolves_project_then_global_as_long_id() {
        let (store, _tmp) = temp_store();
        // Global default is already a long id.
        assert_eq!(store.default_model(None), "claude-opus-4-8");
        assert_eq!(store.default_effort(None), "medium");

        // A per-project override wins for that project; effort falls back to global.
        store
            .update(
                serde_json::from_str(r#"{"projectId":"p1","defaultModel":"claude-sonnet-4-6"}"#)
                    .unwrap(),
            )
            .expect("update");
        assert_eq!(store.default_model(Some("p1")), "claude-sonnet-4-6");
        assert_eq!(store.default_model(Some("other")), "claude-opus-4-8");
        assert_eq!(store.default_effort(Some("p1")), "medium");
    }

    #[test]
    fn default_model_canonicalizes_a_legacy_persisted_short_id() {
        // A settings file from before P0 stored `opus-4.8`; the resolver still hands
        // back a valid SDK long id so the legacy default keeps working.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"opus-4.8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","theme":"cosmic",
            "cleanupWorktrees":true,"notifyOnComplete":false,"projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();

        let store = SettingsStore::load_from(dir);
        assert_eq!(store.default_model(None), "claude-opus-4-8");
    }

    #[test]
    fn global_patch_merges_and_round_trips() {
        let (store, tmp) = temp_store();
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"maxConcurrency":5,"defaultModel":"sonnet-4.6"}"#).unwrap();
        let merged = store.update(patch).expect("update");
        assert_eq!(merged.max_concurrency, 5);
        assert_eq!(merged.default_model, "sonnet-4.6");
        // Untouched fields keep their defaults.
        assert_eq!(merged.permission_mode, "bypass");

        // Persisted: a fresh store reloads the merged values.
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert_eq!(reloaded.get().max_concurrency, 5);
        assert_eq!(reloaded.get().default_model, "sonnet-4.6");
    }

    #[test]
    fn project_patch_writes_an_override_not_the_global() {
        let (store, _tmp) = temp_store();
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"projectId":"proj-1","defaultModel":"haiku-4.5"}"#).unwrap();
        let merged = store.update(patch).expect("update");

        // Global default is unchanged; the override carries the project-scoped value.
        assert_eq!(merged.default_model, "claude-opus-4-8");
        let ov = merged
            .project_overrides
            .get("proj-1")
            .expect("override exists");
        assert_eq!(ov.default_model.as_deref(), Some("haiku-4.5"));
        assert!(ov.default_effort.is_none(), "only the patched field is set");
    }

    #[test]
    fn drop_project_override_removes_it_and_persists() {
        // data-integrity #4: deleting a project drops its override so it can't orphan.
        let (store, tmp) = temp_store();
        store
            .update(
                serde_json::from_str(r#"{"projectId":"p1","defaultModel":"claude-sonnet-4-6"}"#)
                    .unwrap(),
            )
            .expect("seed override");
        assert!(store.get().project_overrides.contains_key("p1"));

        store.drop_project_override("p1").expect("drop");
        assert!(
            !store.get().project_overrides.contains_key("p1"),
            "override is gone from memory"
        );
        // Persisted: a reload no longer carries the orphaned override.
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert!(!reloaded.get().project_overrides.contains_key("p1"));

        // Dropping a non-existent override is a no-op (no error).
        store.drop_project_override("ghost").expect("no-op drop");
    }

    #[test]
    fn parses_the_neutral_autonomy_vocabulary() {
        use crate::contracts::AutonomyLevel;
        // Issue #18: the settings vocabulary IS the neutral wire vocabulary — a
        // fail-safe parse, no SDK mapping (that lowering is now engine-side).
        assert_eq!(parse_autonomy("bypass"), AutonomyLevel::Bypass);
        assert_eq!(parse_autonomy("auto-accept"), AutonomyLevel::AutoAccept);
        assert_eq!(parse_autonomy("plan"), AutonomyLevel::Plan);
        assert_eq!(parse_autonomy("ask"), AutonomyLevel::Ask);
        // An unrecognized value resolves to the studio default (bypass), never a
        // silent prompt-everything — the autonomous-studio choice.
        assert_eq!(parse_autonomy("garbage"), AutonomyLevel::Bypass);
        // `autonomy_wire_str` is the exact inverse for every level (matches the
        // codegen'd kebab-case serde), so the round-trip can't drift.
        for level in [
            AutonomyLevel::Bypass,
            AutonomyLevel::AutoAccept,
            AutonomyLevel::Ask,
            AutonomyLevel::Plan,
        ] {
            assert_eq!(parse_autonomy(autonomy_wire_str(level)), level);
        }
    }

    #[test]
    fn autonomy_prefers_project_override() {
        use crate::contracts::AutonomyLevel;
        let (store, _tmp) = temp_store();
        // Global default is bypass (issue #18: the neutral value travels the wire).
        assert_eq!(store.autonomy(None), AutonomyLevel::Bypass);

        // A per-project override to `ask` wins for that project only — this is how
        // a single project opts OUT of global bypass back into prompting.
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"projectId":"p1","permissionMode":"ask"}"#).unwrap();
        store.update(patch).expect("update");
        assert_eq!(store.autonomy(Some("p1")), AutonomyLevel::Ask);
        assert_eq!(store.autonomy(Some("other")), AutonomyLevel::Bypass);
        assert_eq!(store.autonomy(None), AutonomyLevel::Bypass);
    }

    #[test]
    fn default_run_mode_defaults_to_main_globally_and_per_project() {
        use crate::task::RunMode;
        let (store, _tmp) = temp_store();
        // The global default is `main` (worktrees opt-in).
        assert_eq!(Settings::default().default_run_mode, "main");
        assert_eq!(store.default_run_mode(None), RunMode::Main);
        assert_eq!(store.default_run_mode(Some("any")), RunMode::Main);

        // A global override flips it for every project without an own override.
        store
            .update(serde_json::from_str(r#"{"defaultRunMode":"worktree"}"#).unwrap())
            .expect("update");
        assert_eq!(store.default_run_mode(None), RunMode::Worktree);

        // A per-project override wins for that project only.
        store
            .update(serde_json::from_str(r#"{"projectId":"p1","defaultRunMode":"main"}"#).unwrap())
            .expect("update");
        assert_eq!(store.default_run_mode(Some("p1")), RunMode::Main);
        assert_eq!(store.default_run_mode(Some("other")), RunMode::Worktree);
    }

    #[test]
    fn default_run_mode_fails_safe_to_main_on_garbage() {
        use crate::task::RunMode;
        // An unrecognized stored value resolves to Main, never silently worktree.
        assert_eq!(parse_run_mode("garbage"), RunMode::Main);
        assert_eq!(parse_run_mode("main"), RunMode::Main);
        assert_eq!(parse_run_mode("worktree"), RunMode::Worktree);
    }

    #[test]
    fn legacy_settings_without_run_mode_loads_as_main() {
        // A settings.json from before M4.6 (no `defaultRunMode`) still parses and
        // defaults the field to "main" — existing config files aren't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"opus-4.8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"auto-accept","theme":"cosmic",
            "cleanupWorktrees":true,"notifyOnComplete":false,"projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();

        let store = SettingsStore::load_from(dir);
        assert_eq!(store.get().default_run_mode, "main");
        assert_eq!(store.default_run_mode(None), crate::task::RunMode::Main);
        // Issue #18: the same legacy file (no `provider` key) loads the serde-additive
        // default `claude` — an existing settings file is never broken by the field.
        assert_eq!(store.get().provider, "claude");
    }

    #[test]
    fn settings_serializes_camel_case() {
        let value = serde_json::to_value(Settings::default()).unwrap();
        let obj = value.as_object().unwrap();
        for key in [
            "defaultModel",
            "maxConcurrency",
            "permissionMode",
            "cleanupWorktrees",
            "notifyOnComplete",
            "defaultRunMode",
            "maxTurns",
            "maxBudgetUsd",
            "mcpServers",
            "contextPackEnabled",
            "preferredEditor",
            "terminalFontSize",
            "terminalScrollback",
            "projectOverrides",
        ] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }
    }

    #[test]
    fn terminal_render_prefs_default_none_and_merge_set_only() {
        // Cockpit PR 3 decision 6e: no render-pref override by default — a fresh
        // install uses the shipped 13px / ~10k web-side defaults (None here).
        let defaults = Settings::default();
        assert!(defaults.terminal_font_size.is_none());
        assert!(defaults.terminal_scrollback.is_none());

        // A settings.json from before the fields still parses, defaulting them None.
        let legacy: Settings = serde_json::from_str("{\"defaultModel\":\"m\",\"defaultEffort\":\"medium\",\"maxConcurrency\":3,\"permissionMode\":\"bypass\",\"cleanupWorktrees\":true,\"notifyOnComplete\":false,\"projectOverrides\":{}}").expect("legacy settings parse");
        assert!(legacy.terminal_font_size.is_none());
        assert!(legacy.terminal_scrollback.is_none());

        // A global patch SETS both knobs.
        let mut s = Settings::default();
        s.merge(SettingsPatch {
            terminal_font_size: Some(16),
            terminal_scrollback: Some(50_000),
            ..Default::default()
        });
        assert_eq!(s.terminal_font_size, Some(16));
        assert_eq!(s.terminal_scrollback, Some(50_000));

        // An omitted key is a no-op — a later patch that touches only the font size
        // leaves the scrollback in place.
        s.merge(SettingsPatch {
            terminal_font_size: Some(14),
            ..Default::default()
        });
        assert_eq!(s.terminal_font_size, Some(14));
        assert_eq!(s.terminal_scrollback, Some(50_000));
    }

    #[test]
    fn preferred_editor_defaults_none_and_is_serde_additive() {
        // The worktree open-in-editor pin is unset by default (auto-detect).
        assert!(Settings::default().preferred_editor.is_none());

        // A settings.json from before the field still parses, defaulting it to None.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(store.get().preferred_editor.is_none());
    }

    #[test]
    fn preferred_editor_patch_sets_and_the_empty_sentinel_clears() {
        let (store, _tmp) = temp_store();
        // A non-empty value pins the editor.
        store
            .update(serde_json::from_str(r#"{"preferredEditor":"code"}"#).unwrap())
            .expect("set editor");
        assert_eq!(store.get().preferred_editor.as_deref(), Some("code"));

        // The empty-string "Auto" sentinel clears the pin back to auto-detect.
        store
            .update(serde_json::from_str(r#"{"preferredEditor":""}"#).unwrap())
            .expect("clear editor");
        assert!(store.get().preferred_editor.is_none());

        // An omitted key is a no-op: pinning again then sending an unrelated patch
        // must leave the editor untouched.
        store
            .update(serde_json::from_str(r#"{"preferredEditor":"cursor"}"#).unwrap())
            .expect("set editor again");
        store
            .update(serde_json::from_str(r#"{"notifyOnComplete":true}"#).unwrap())
            .expect("unrelated patch");
        assert_eq!(store.get().preferred_editor.as_deref(), Some("cursor"));
    }

    #[test]
    fn notify_on_awaiting_input_defaults_on_and_is_serde_additive() {
        // T11: unlike `notify_on_complete` (Done/Failed, default off), the
        // awaiting-input park notification defaults ON.
        assert!(Settings::default().notify_on_awaiting_input);

        // A settings.json from before this field (no `notifyOnAwaitingInput`) still
        // parses, defaulting the field to `true` — a legacy install gets the park
        // notification without editing its config (serde-additive).
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(store.get().notify_on_awaiting_input);

        // A global patch turns it OFF and round-trips through persistence.
        store
            .update(serde_json::from_str(r#"{"notifyOnAwaitingInput":false}"#).unwrap())
            .expect("update");
        assert!(!store.get().notify_on_awaiting_input);
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert!(!reloaded.get().notify_on_awaiting_input);
    }

    #[test]
    fn terminal_bell_notify_defaults_on_and_is_serde_additive() {
        // T11: terminal command-completion notifications default ON (an OSC/BEL is an
        // explicit signal, not a busy/idle guess).
        assert!(Settings::default().terminal_bell_notify);

        // A settings.json from before this field still parses, defaulting it `true`.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(store.get().terminal_bell_notify);

        // A global patch turns it OFF and round-trips through persistence.
        store
            .update(serde_json::from_str(r#"{"terminalBellNotify":false}"#).unwrap())
            .expect("update");
        assert!(!store.get().terminal_bell_notify);
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert!(!reloaded.get().terminal_bell_notify);
    }

    #[test]
    fn usage_meter_enabled_defaults_false_and_is_serde_additive() {
        // Issue #121 decision 5: the usage meter is opt-in (default off).
        assert!(!Settings::default().usage_meter_enabled);

        // A settings.json from before the usage meter (no `usageMeterEnabled`) still
        // parses, defaulting the field to `false` — existing config isn't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(!store.get().usage_meter_enabled);

        // A global patch flips it on and round-trips through persistence.
        store
            .update(serde_json::from_str(r#"{"usageMeterEnabled":true}"#).unwrap())
            .expect("update");
        assert!(store.get().usage_meter_enabled);
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert!(reloaded.get().usage_meter_enabled);
    }

    #[test]
    fn auto_pause_usage_threshold_defaults_90_and_is_serde_additive() {
        // Spec 2026-07-11 decision 2: the usage-throttle ceiling defaults to 90%.
        assert_eq!(Settings::default().auto_pause_usage_threshold, 90);

        // A settings.json from before this field (no `autoPauseUsageThreshold`) still
        // parses, defaulting to 90 — existing config isn't broken (serde-additive).
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert_eq!(store.get().auto_pause_usage_threshold, 90);

        // A global patch sets it and round-trips through persistence.
        store
            .update(serde_json::from_str(r#"{"autoPauseUsageThreshold":75}"#).unwrap())
            .expect("update");
        assert_eq!(store.get().auto_pause_usage_threshold, 75);
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert_eq!(reloaded.get().auto_pause_usage_threshold, 75);
    }

    #[test]
    fn auto_pause_usage_threshold_clamps_to_50_100_on_merge() {
        // The slider is 50..=100, but the patch defends the store: an out-of-range
        // value clamps rather than persisting a nonsensical threshold.
        let (store, _tmp) = temp_store();
        store
            .update(serde_json::from_str(r#"{"autoPauseUsageThreshold":10}"#).unwrap())
            .expect("update low");
        assert_eq!(
            store.get().auto_pause_usage_threshold,
            50,
            "clamped up to 50"
        );
        store
            .update(serde_json::from_str(r#"{"autoPauseUsageThreshold":200}"#).unwrap())
            .expect("update high");
        assert_eq!(
            store.get().auto_pause_usage_threshold,
            100,
            "clamped down to 100"
        );
        // A boundary value passes through unchanged.
        store
            .update(serde_json::from_str(r#"{"autoPauseUsageThreshold":50}"#).unwrap())
            .expect("update boundary");
        assert_eq!(store.get().auto_pause_usage_threshold, 50);
    }

    #[test]
    fn terminal_yolo_launch_defaults_false_and_is_serde_additive() {
        // Cockpit PR 4 decision 3: the YOLO launch flag is opt-in (default off).
        assert!(!Settings::default().terminal_yolo_launch);

        // A settings.json from before the flag (no `terminalYoloLaunch`) still parses,
        // defaulting the field to `false` — existing config isn't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(!store.get().terminal_yolo_launch);

        // A global patch flips it on and round-trips through persistence.
        store
            .update(serde_json::from_str(r#"{"terminalYoloLaunch":true}"#).unwrap())
            .expect("update");
        assert!(store.get().terminal_yolo_launch);
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert!(reloaded.get().terminal_yolo_launch);
    }

    #[test]
    fn issue_sync_settings_default_off_and_are_serde_additive() {
        // #97: issue writeback is opt-in (default off) and the label prefix defaults
        // to `nc:` via `label_prefix()`.
        let defaults = Settings::default();
        assert!(!defaults.issue_sync_enabled);
        assert!(defaults.issue_label_prefix.is_none());
        assert_eq!(defaults.label_prefix(), "nc:");

        // A settings.json from before the fields (no `issueSyncEnabled` /
        // `issueLabelPrefix`) still parses, defaulting off + `nc:` — existing config
        // isn't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(!store.get().issue_sync_enabled);
        assert_eq!(store.get().label_prefix(), "nc:");

        // A global patch flips the toggle on and remaps the prefix; both round-trip
        // through persistence.
        store
            .update(
                serde_json::from_str(r#"{"issueSyncEnabled":true,"issueLabelPrefix":"track:"}"#)
                    .unwrap(),
            )
            .expect("update");
        assert!(store.get().issue_sync_enabled);
        assert_eq!(store.get().label_prefix(), "track:");
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert!(reloaded.get().issue_sync_enabled);
        assert_eq!(reloaded.get().issue_label_prefix.as_deref(), Some("track:"));

        // The empty-string sentinel clears the prefix back to the default `nc:`
        // (mirrors `preferred_editor`), so the field can be reset without a null.
        store
            .update(serde_json::from_str(r#"{"issueLabelPrefix":""}"#).unwrap())
            .expect("update");
        assert!(store.get().issue_label_prefix.is_none());
        assert_eq!(store.get().label_prefix(), "nc:");
    }

    #[test]
    fn context_pack_enabled_defaults_true_and_is_serde_additive() {
        // Lock (feature #4): the curated Constitution is injected by default.
        assert!(Settings::default().context_pack_enabled);

        // A settings.json from before the Context Pack UI (no `contextPackEnabled`)
        // still parses, defaulting the field to `true` — existing config isn't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(store.get().context_pack_enabled);
        assert!(store.context_pack_enabled(None));
    }

    #[test]
    fn legacy_settings_without_sidebar_style_loads_as_none() {
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(store.get().sidebar_style.is_none());
        assert_eq!(
            super::model::resolve_sidebar_style(store.get().sidebar_style.as_deref()),
            "unified"
        );
    }

    #[test]
    fn context_pack_enabled_resolves_project_then_global() {
        let (store, _tmp) = temp_store();
        // Global default is on for every project without an own override.
        assert!(store.context_pack_enabled(None));
        assert!(store.context_pack_enabled(Some("any")));

        // A per-project override OFF wins for that project only — how a project opts
        // out of the on-rails Constitution.
        store
            .update(
                serde_json::from_str(r#"{"projectId":"p1","contextPackEnabled":false}"#).unwrap(),
            )
            .expect("update");
        assert!(!store.context_pack_enabled(Some("p1")));
        assert!(store.context_pack_enabled(Some("other")));
        assert!(store.context_pack_enabled(None));

        // The override is project-scoped, not global.
        let merged = store.get();
        assert!(merged.context_pack_enabled, "global stays on");
        assert_eq!(
            merged
                .project_overrides
                .get("p1")
                .unwrap()
                .context_pack_enabled,
            Some(false)
        );

        // A global toggle OFF flips it for projects without an own override.
        store
            .update(serde_json::from_str(r#"{"contextPackEnabled":false}"#).unwrap())
            .expect("global update");
        assert!(!store.context_pack_enabled(None));
        assert!(!store.context_pack_enabled(Some("other")));
        // The project override still wins (it is explicitly false too here).
        assert!(!store.context_pack_enabled(Some("p1")));
    }

    /// A stdio server entry fixture for the MCP tests.
    fn stdio_entry(id: &str, name: &str, enabled: bool) -> McpServerEntry {
        McpServerEntry {
            id: id.to_string(),
            name: name.to_string(),
            enabled,
            config: McpServerTransport::Stdio {
                command: "npx".to_string(),
                args: vec!["-y".to_string(), "pkg".to_string()],
                env: HashMap::new(),
            },
        }
    }

    #[test]
    fn mcp_servers_default_to_empty_and_are_serde_additive() {
        // A fresh Settings has no MCP servers; the resolver returns an empty list.
        let s = Settings::default();
        assert!(s.mcp_servers.is_empty());

        // A settings.json from before the MCP UI (no `mcpServers`) still parses,
        // defaulting the field to `[]` — existing config files aren't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(store.get().mcp_servers.is_empty());
        assert!(store.enabled_mcp_servers(None).is_empty());
    }

    #[test]
    fn mcp_servers_round_trip_persist_and_reload() {
        let (store, tmp) = temp_store();
        let patch: SettingsPatch = serde_json::from_str(
            r#"{"mcpServers":[
                {"id":"s1","name":"filesystem","enabled":true,
                 "config":{"transport":"stdio","command":"npx","args":["-y","pkg"],"env":{"ROOT":"/x"}}},
                {"id":"s2","name":"github","enabled":false,
                 "config":{"transport":"http","url":"https://x/mcp","headers":{"Authorization":"Bearer t"}}}
            ]}"#,
        )
        .unwrap();
        let merged = store.update(patch).expect("update");
        assert_eq!(merged.mcp_servers.len(), 2);

        // Persisted: a fresh store reloads the exact list (including the http entry's
        // headers and the disabled flag).
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        let servers = reloaded.get().mcp_servers;
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "filesystem");
        assert!(matches!(
            &servers[1].config,
            McpServerTransport::Http { url, headers }
                if url == "https://x/mcp" && headers.get("Authorization").is_some()
        ));
    }

    #[test]
    fn enabled_mcp_servers_filters_disabled_entries() {
        let (store, _tmp) = temp_store();
        store
            .update(SettingsPatch {
                mcp_servers: Some(vec![
                    stdio_entry("a", "alpha", true),
                    stdio_entry("b", "bravo", false),
                    stdio_entry("c", "charlie", true),
                ]),
                ..Default::default()
            })
            .expect("update");

        let enabled = store.enabled_mcp_servers(None);
        let names: Vec<&str> = enabled.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["alpha", "charlie"],
            "only enabled entries inject"
        );
    }

    #[test]
    fn enabled_mcp_servers_resolves_project_override_then_global() {
        let (store, _tmp) = temp_store();
        // Global list: one enabled server.
        store
            .update(SettingsPatch {
                mcp_servers: Some(vec![stdio_entry("g", "global-srv", true)]),
                ..Default::default()
            })
            .expect("global update");
        // Every project without an own list sees the global one.
        assert_eq!(
            store
                .enabled_mcp_servers(Some("other"))
                .iter()
                .map(|s| s.name.clone())
                .collect::<Vec<_>>(),
            vec!["global-srv".to_string()]
        );

        // A project override REPLACES the global list wholesale for that project.
        store
            .update(SettingsPatch {
                project_id: Some("p1".to_string()),
                mcp_servers: Some(vec![stdio_entry("p", "project-srv", true)]),
                ..Default::default()
            })
            .expect("project update");
        assert_eq!(
            store
                .enabled_mcp_servers(Some("p1"))
                .iter()
                .map(|s| s.name.clone())
                .collect::<Vec<_>>(),
            vec!["project-srv".to_string()],
            "the project override wins and replaces the global list"
        );
        // The global list and other projects are untouched.
        assert_eq!(
            store.enabled_mcp_servers(None),
            vec![stdio_entry("g", "global-srv", true)]
        );
    }

    #[test]
    fn mcp_servers_project_patch_writes_an_override_not_the_global() {
        let (store, _tmp) = temp_store();
        let merged = store
            .update(SettingsPatch {
                project_id: Some("proj-1".to_string()),
                mcp_servers: Some(vec![stdio_entry("x", "x", true)]),
                ..Default::default()
            })
            .expect("update");

        // The global list is untouched; the override carries the project's list.
        assert!(merged.mcp_servers.is_empty(), "global list stays empty");
        let ov = merged
            .project_overrides
            .get("proj-1")
            .expect("override exists");
        assert_eq!(ov.mcp_servers.as_ref().map(|l| l.len()), Some(1));

        // The UI clears a project's list by sending an explicit EMPTY list
        // (`Some([])`), which replaces it — not by omitting the key. (An omitted
        // `mcpServers` is a no-op, like the `Option` ceilings: serde maps absent and
        // null to `None`, so the override list can only be SET/replaced, never
        // implicitly cleared.) `Some([])` here leaves an empty override list, so the
        // override block survives (it carries an intentional empty list).
        store
            .update(SettingsPatch {
                project_id: Some("proj-1".to_string()),
                mcp_servers: Some(vec![]),
                ..Default::default()
            })
            .expect("clear to empty");
        let ov = store.get();
        let ov = ov.project_overrides.get("proj-1").expect("override exists");
        assert_eq!(
            ov.mcp_servers.as_ref().map(|l| l.len()),
            Some(0),
            "an explicit empty list replaces the override list"
        );
        // And that project now injects nothing (resolves to the empty override list,
        // NOT back to the global list).
        assert!(store.enabled_mcp_servers(Some("proj-1")).is_empty());
    }

    #[test]
    fn guardrail_defaults_are_none_and_serde_additive() {
        // SDK-guardrails: with no Settings knob set, the resolvers return None so a
        // new task inherits the engine's `@nightcore/config` default.
        let s = Settings::default();
        assert!(
            s.max_turns.is_none(),
            "max_turns defaults to None (inherit)"
        );
        assert!(
            s.max_budget_usd.is_none(),
            "max_budget_usd defaults to None (uncapped)"
        );

        // A settings.json from before the guardrails UI (no `maxTurns`/
        // `maxBudgetUsd`) still parses, defaulting both to None — the pinning
        // guarantee, so existing config files aren't broken.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main","projectOverrides":{}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        assert!(store.get().max_turns.is_none());
        assert!(store.get().max_budget_usd.is_none());
        assert_eq!(store.default_max_turns(None), None);
        assert_eq!(store.default_max_budget_usd(None), None);
    }

    #[test]
    fn default_max_turns_resolves_project_then_global_then_none() {
        let (store, _tmp) = temp_store();
        // No knob set anywhere → None (inherit the config default).
        assert_eq!(store.default_max_turns(None), None);
        assert_eq!(store.default_max_budget_usd(None), None);

        // A global ceiling flips it for every project without an own override.
        store
            .update(serde_json::from_str(r#"{"maxTurns":150,"maxBudgetUsd":5.0}"#).unwrap())
            .expect("update");
        assert_eq!(store.default_max_turns(None), Some(150));
        assert_eq!(store.default_max_turns(Some("any")), Some(150));
        assert_eq!(store.default_max_budget_usd(Some("any")), Some(5.0));

        // A per-project override wins for that project only.
        store
            .update(
                serde_json::from_str(r#"{"projectId":"p1","maxTurns":50,"maxBudgetUsd":1.0}"#)
                    .unwrap(),
            )
            .expect("update");
        assert_eq!(store.default_max_turns(Some("p1")), Some(50));
        assert_eq!(store.default_max_budget_usd(Some("p1")), Some(1.0));
        // Another project still sees the global ceiling.
        assert_eq!(store.default_max_turns(Some("other")), Some(150));
        assert_eq!(store.default_max_budget_usd(Some("other")), Some(5.0));
    }

    #[test]
    fn guardrail_project_patch_writes_an_override_not_the_global() {
        let (store, _tmp) = temp_store();
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"projectId":"proj-1","maxTurns":42}"#).unwrap();
        let merged = store.update(patch).expect("update");

        // The global ceiling is untouched; the override carries the project value.
        assert!(merged.max_turns.is_none(), "global stays None");
        let ov = merged
            .project_overrides
            .get("proj-1")
            .expect("override exists");
        assert_eq!(ov.max_turns, Some(42));
        assert!(ov.max_budget_usd.is_none(), "only the patched field is set");
    }

    // --- Custom Board Background -------------------------------------------

    #[test]
    fn board_appearance_default_reproduces_the_pre_feature_look() {
        // Every knob at its identity value: opacities 1.0 (solid), borders shown,
        // no glass, scrollbar shown — so a project that never opens the panel looks
        // exactly like it did before the feature.
        let a = BoardAppearance::default();
        assert_eq!(a.card_opacity, 1.0);
        assert_eq!(a.column_opacity, 1.0);
        assert_eq!(a.card_border_opacity, 1.0);
        assert!(a.show_column_borders);
        assert!(a.show_card_borders);
        assert!(!a.card_glassmorphism);
        assert!(!a.hide_board_scrollbar);
    }

    #[test]
    fn board_appearance_is_serde_additive_and_partial_tolerant() {
        // A settings.json from before the feature (no board fields in the override)
        // still parses, defaulting board_appearance / board_background to None.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("config");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{"defaultModel":"claude-opus-4-8","defaultEffort":"medium",
            "maxConcurrency":3,"permissionMode":"bypass","cleanupWorktrees":true,
            "notifyOnComplete":false,"defaultRunMode":"main",
            "projectOverrides":{"p1":{"defaultModel":"claude-sonnet-4-6"}}}"#;
        std::fs::write(dir.join("settings.json"), legacy).unwrap();
        let store = SettingsStore::load_from(dir);
        let ov = store.get().project_overrides.get("p1").unwrap().clone();
        assert!(
            ov.board_appearance.is_none(),
            "legacy override has no appearance"
        );
        assert!(
            store.board_background("p1").is_none(),
            "legacy override has no bg"
        );

        // A partial BoardAppearance object (only cardOpacity present) loads, with the
        // omitted knobs falling back to their pre-feature defaults (forward-compat).
        let partial: BoardAppearance =
            serde_json::from_str(r#"{"cardOpacity":0.5}"#).expect("partial parses");
        assert_eq!(partial.card_opacity, 0.5);
        assert_eq!(partial.column_opacity, 1.0, "omitted knob defaults");
        assert!(partial.show_card_borders, "omitted toggle defaults on");
    }

    #[test]
    fn board_appearance_patch_writes_an_override_not_the_global() {
        let (store, tmp) = temp_store();
        let patch: SettingsPatch = serde_json::from_str(
            r#"{"projectId":"p1","boardAppearance":{"cardOpacity":0.6,"columnOpacity":0.7,
                "showColumnBorders":false,"showCardBorders":true,"cardGlassmorphism":true,
                "cardBorderOpacity":0.8,"hideBoardScrollbar":true}}"#,
        )
        .unwrap();
        let merged = store.update(patch).expect("update");
        let ov = merged.project_overrides.get("p1").expect("override exists");
        let a = ov.board_appearance.as_ref().expect("appearance set");
        assert_eq!(a.card_opacity, 0.6);
        assert!(a.card_glassmorphism);
        assert!(a.hide_board_scrollbar);
        assert!(!a.show_column_borders);

        // Persisted: a fresh store reloads the exact appearance.
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        let a2 = reloaded
            .get()
            .project_overrides
            .get("p1")
            .unwrap()
            .board_appearance
            .clone()
            .expect("reloaded appearance");
        assert_eq!(a2.column_opacity, 0.7);
    }

    #[test]
    fn set_board_background_bumps_version_and_persists_then_clear_prunes() {
        let (store, tmp) = temp_store();
        // First set ⇒ version 1.
        let s1 = store
            .set_board_background("p1", "gif".to_string())
            .expect("set");
        let bg1 = s1
            .project_overrides
            .get("p1")
            .unwrap()
            .board_background
            .clone()
            .unwrap();
        assert_eq!(bg1.format, "gif");
        assert_eq!(bg1.version, 1);

        // A same-format replace bumps the version so the web cache-busts.
        let s2 = store
            .set_board_background("p1", "gif".to_string())
            .expect("re-set");
        assert_eq!(
            store.board_background("p1").unwrap().version,
            2,
            "version bumps on replace"
        );
        assert_eq!(
            s2.project_overrides
                .get("p1")
                .unwrap()
                .board_background
                .as_ref()
                .unwrap()
                .format,
            "gif"
        );

        // Persisted across reload.
        let reloaded = SettingsStore::load_from(tmp.path().join("config"));
        assert_eq!(reloaded.board_background("p1").unwrap().version, 2);

        // Clear drops the ref; with no other override fields the block is pruned so
        // it can't orphan (data-integrity #4).
        let cleared = store.clear_board_background("p1").expect("clear");
        assert!(store.board_background("p1").is_none(), "ref gone");
        assert!(
            !cleared.project_overrides.contains_key("p1"),
            "empty override pruned"
        );
        // Clearing again is a no-op.
        store
            .clear_board_background("p1")
            .expect("idempotent clear");
    }

    #[test]
    fn clear_board_background_keeps_a_nonempty_override() {
        let (store, _tmp) = temp_store();
        // An override that also carries a real setting must survive a bg clear.
        store
            .update(
                serde_json::from_str(r#"{"projectId":"p1","defaultModel":"claude-sonnet-4-6"}"#)
                    .unwrap(),
            )
            .expect("seed override");
        store
            .set_board_background("p1", "png".to_string())
            .expect("set bg");
        store.clear_board_background("p1").expect("clear bg");
        let ov = store.get();
        let ov = ov.project_overrides.get("p1").expect("override survives");
        assert!(ov.board_background.is_none(), "bg ref cleared");
        assert_eq!(
            ov.default_model.as_deref(),
            Some("claude-sonnet-4-6"),
            "other setting kept"
        );
    }
}
