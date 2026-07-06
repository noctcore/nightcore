//! The Tauri event channel names the sidecar reader emits on. Pure string
//! constants (no imports), re-exported through `sidecar/mod.rs` so the historical
//! `crate::sidecar::*` paths keep resolving after the god-file split.

/// The Tauri event carrying one streamed sidecar event for a task.
/// Payload: `{ taskId: string, event: NightcoreEvent }`.
pub(crate) const SESSION_EVENT: &str = "nc:session";

/// The Tauri event carrying an interactive permission prompt for a task. Payload:
/// `{ taskId, requestId, toolName, input, suggestions? }`. The webview renders the
/// prompt and answers via the `respond_permission` command. Permission inputs may
/// contain paths/commands — they are surfaced to the UI but NEVER logged.
pub(crate) const PERMISSION_EVENT: &str = "nc:permission";

/// The Tauri event carrying an interactive `AskUserQuestion` prompt for a task.
/// Payload: `{ taskId, requestId, toolUseId?, questions }`. The webview renders the
/// question picker and answers via the `answer_question` command. Question prompts
/// carry the model's question/option text — surfaced to the UI but NEVER logged.
pub(crate) const QUESTION_EVENT: &str = "nc:question";

/// The Tauri event carrying one streamed Insight `analysis-*` event. Unlike
/// `nc:session`, the payload is the raw `NightcoreEvent` (it already carries its
/// own `runId`); the Insight view folds the stream and reconciles against the
/// persisted run on completion.
pub(crate) const INSIGHT_EVENT: &str = "nc:insight";

/// The Tauri event carrying one streamed Harness `harness-*` event. Like
/// `nc:insight`, the payload is the raw `NightcoreEvent` (it carries its own
/// `runId`); the Harness view folds the stream and reconciles against the persisted
/// run on completion. `apply_harness_artifact` also emits an `artifact-applied`
/// notice on this channel.
pub(crate) const HARNESS_EVENT: &str = "nc:harness";

/// The Tauri event carrying one streamed Scorecard `scorecard-*` event. Like
/// `nc:insight`, the payload is the raw `NightcoreEvent` (it carries its own
/// `runId`); the Scorecard view folds the stream and reconciles against the
/// persisted run on completion. `convert_reading_to_task` also emits a
/// `reading-converted` notice on this channel.
pub(crate) const SCORECARD_EVENT: &str = "nc:scorecard";

/// The Tauri event carrying one streamed PR Review `pr-review-*` event. Like
/// `nc:insight`, the payload is the raw `NightcoreEvent` (it carries its own `runId`);
/// the PR Review view folds the stream and reconciles against the persisted run on
/// completion. `convert_review_finding_to_task` also emits a `pr-review-finding-converted`
/// notice on this channel.
pub(crate) const PRREVIEW_EVENT: &str = "nc:pr-review";

/// The Tauri event carrying one streamed Issue Triage `issue-validation-*` event. Like
/// `nc:pr-review`, the payload is the raw `NightcoreEvent` (it carries its own `runId`);
/// the Issues view folds the stream and reconciles against the persisted validation on
/// completion. `convert_issue_validation_to_task` also emits an
/// `issue-validation-converted` notice on this channel.
pub(crate) const ISSUE_TRIAGE_EVENT: &str = "nc:issue-triage";
