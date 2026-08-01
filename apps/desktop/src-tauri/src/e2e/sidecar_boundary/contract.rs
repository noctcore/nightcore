//! Ring 3(b)'s assertions: the core's OWN encoder and decoder, run against a live
//! sidecar child. See [`super`] for what each of these covers that rings 1(c) and 3
//! do not.

use std::time::Duration;

use crate::contracts::{
    AutonomyLevel, ErrorCategory, HarnessPolicy, ImageFormat, McpServerEntry, McpServerTransport,
    NightcoreEvent, SessionFailedReason, SurfaceQuery, WireImage,
};
use crate::provider::{Guardrails, Provider};

use super::harness::Boundary;

/// A deliberately WIDE guardrail payload. Every optional here is a field the Rust
/// serializer maps by hand (`then_some`, `Option` omission, a nested codegen'd
/// struct) and the sidecar's zod validates on the way in — so the widest command
/// the core can construct is the one this ring puts on the wire.
fn wide_guardrails() -> Guardrails {
    Guardrails {
        max_turns: Some(30),
        max_budget_usd: Some(1.5),
        resume_session_id: None,
        mcp_servers: vec![McpServerEntry {
            id: "ring3b".to_string(),
            name: "ring3b".to_string(),
            enabled: true,
            config: McpServerTransport::Stdio {
                command: "true".to_string(),
                args: vec!["--noop".to_string()],
                env: serde_json::Map::new(),
            },
        }],
        append_context_pack: Some("# Scratch constitution\n".to_string()),
        harness_policy: Some(HarnessPolicy {
            protected_paths: vec![".github/**".to_string()],
            deny_bash_patterns: vec!["rm -rf /".to_string()],
            deny_read_paths: vec![".env".to_string()],
            disallowed_tools: vec![],
            allow_tools: vec!["Read".to_string()],
            ask_tools: vec!["Bash".to_string()],
            allow_exec_sinks: vec![],
        }),
        ledger_path: Some("ledger.ndjson".to_string()),
        sandbox_writes: true,
    }
}

/// A 1×1 transparent PNG — the smallest legal image attachment.
const TINY_PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/// core → sidecar → core, all production code: the Rust `start_session` serializer
/// writes a wide `start-session` over a real pipe, the live sidecar's zod ACCEPTS
/// it, the engine's supervisor assigns an id, the transcript replays, and every
/// line comes back decodable into the core's own `NightcoreEvent`.
///
/// If the Rust serializer ever emits a payload the sidecar's `SurfaceCommandSchema`
/// rejects, nothing appears on stdout and this reds on the `session-started` wait —
/// the exact production failure (a run that never starts) surfaced as a test
/// failure. No other tier can catch that: zod runs only in the sidecar.
#[tokio::test]
async fn rust_serialized_start_session_drives_a_live_session_to_completion() {
    let mut boundary = Boundary::boot();
    let scratch = boundary.scratch();
    let provider = boundary.provider().await;

    provider
        .start_session(
            "ring3b-task",
            "replay the build transcript".to_string(),
            Some("claude".to_string()),
            Some("replay-fixture".to_string()),
            Some("medium".to_string()),
            Some(scratch.clone()),
            Some(AutonomyLevel::Bypass),
            "build",
            vec![WireImage {
                format: ImageFormat::Png,
                data: TINY_PNG.to_string(),
            }],
            wide_guardrails(),
        )
        .await
        .expect("the core's start-session write reaches the live child");

    // The supervisor's own opener — it appears in NO fixture transcript, so this is
    // the running engine's shape, not a recorded one.
    let started = boundary
        .wait_for("session-started", |e| {
            matches!(e, NightcoreEvent::SessionStarted { .. })
        })
        .await;
    let NightcoreEvent::SessionStarted {
        session_id, prompt, ..
    } = started
    else {
        unreachable!("matched above")
    };
    assert_eq!(
        prompt, "replay the build transcript",
        "the prompt survived the core's serializer, the pipe, and zod intact"
    );

    // PRODUCTION correlation, against a LIVE session id: `start_session` pushed the
    // pending launch under the stdin lock; the id the engine just assigned must bind
    // back to our task.
    assert_eq!(
        provider.correlate(session_id).as_deref(),
        Some("ring3b-task"),
        "the live session id binds to the launching task through the real FIFO"
    );

    let completed = boundary
        .wait_for("session-completed", |e| {
            matches!(e, NightcoreEvent::SessionCompleted { .. })
        })
        .await;
    let NightcoreEvent::SessionCompleted {
        session_id: completed_id,
        result,
        cost_usd,
        num_turns,
        ..
    } = completed
    else {
        unreachable!("matched above")
    };
    // PAYLOAD equality against the checked-in fixture, not merely "a terminal
    // arrived": a pipeline that mangles a field must red this.
    assert_eq!(completed_id, session_id, "the terminal is our session's");
    assert_eq!(
        result,
        "Awaited the save() call in src/handler.ts and confirmed the test suite passes."
    );
    assert_eq!(cost_usd, Some(0.42));
    assert_eq!(num_turns, 7);

    // The rejection channel stayed quiet — the wide payload above was ACCEPTED, not
    // dropped. (`a_contract_violating_command_is_rejected_by_the_live_sidecar` proves
    // this channel is live and would have spoken.)
    let stderr = boundary.stderr_text();
    assert!(
        !stderr.contains("invalid command"),
        "the live sidecar rejected the core's start-session payload:\n{stderr}"
    );
    assert!(
        stderr.contains("E2E REPLAY MODE"),
        "the child must be in replay mode — a run that reached a real provider would \
         not be free, offline, or deterministic:\n{stderr}"
    );
}

/// The FAILURE half of the boundary: the recorded terminal must decode into the
/// core's typed `SessionFailedReason`/`ErrorCategory`, not merely arrive. These
/// enums drive the circuit breaker (`contracts::trips_breaker_immediately`), so a
/// value the core can't decode would silently change stop-the-loop behavior.
#[tokio::test]
async fn the_failure_transcript_decodes_into_the_cores_typed_terminal() {
    let mut boundary = Boundary::boot();
    let scratch = boundary.scratch();
    let provider = boundary.provider().await;

    provider
        .start_session(
            "ring3b-failing",
            "#replay build-failed".to_string(),
            None,
            Some("replay-fixture".to_string()),
            None,
            Some(scratch),
            Some(AutonomyLevel::Bypass),
            "build",
            vec![],
            Guardrails::default(),
        )
        .await
        .expect("the core's start-session write reaches the live child");

    let failed = boundary
        .wait_for("session-failed", |e| {
            matches!(e, NightcoreEvent::SessionFailed { .. })
        })
        .await;
    let NightcoreEvent::SessionFailed {
        reason,
        message,
        detail,
        ..
    } = failed
    else {
        unreachable!("matched above")
    };
    assert_eq!(
        reason,
        SessionFailedReason::MaxTurns,
        "the wire reason decodes into the core's typed enum"
    );
    assert!(
        message.contains("turn ceiling"),
        "the diagnosis survives the boundary: {message}"
    );
    let detail = detail.expect("the failure carries its typed detail");
    assert_eq!(
        detail.category,
        ErrorCategory::ResourceExhausted,
        "the category the circuit breaker branches on decodes too"
    );
}

/// The request/reply RPC no other ring exercises: `Provider::list_models` /
/// `Provider::capabilities` (both PRODUCTION default trait methods) serialize a
/// `SurfaceQuery`, the live sidecar's `SurfaceQuerySchema` accepts it, the engine
/// answers, and the reply is correlated back by `requestId` and decoded into the
/// codegen'd descriptors.
#[tokio::test]
async fn a_surface_query_round_trips_through_the_live_rpc_correlation() {
    let mut boundary = Boundary::boot();
    let provider = boundary.provider().await;

    let models = provider
        .list_models()
        .await
        .expect("the models query round-trips over the live pipe");
    assert_eq!(models.len(), 1, "replay advertises exactly one model");
    assert_eq!(models[0].value, "replay-fixture");
    assert!(!models[0].supports_effort);

    let caps = provider
        .capabilities()
        .await
        .expect("the capabilities query round-trips over the live pipe");
    assert_eq!(caps.id, "replay");
    assert!(
        !caps.supports_hooks,
        "the descriptor is the provider's own, decoded into the core's struct"
    );
    assert!(caps.autonomy_levels.contains(&AutonomyLevel::Bypass));

    // A query the core never registered a reply for must NOT resolve — the pending
    // map is keyed by the generated request id, so a stray reply is dropped.
    provider.correlate_reply("never-issued", serde_json::json!({"ok": true}));

    let unknown = provider
        .query(SurfaceQuery::GetProviderConfig {
            request_id: String::new(),
            provider_id: None,
            dir: Some(boundary.scratch().to_string_lossy().to_string()),
        })
        .await
        .expect("the provider-config query round-trips too");
    assert_eq!(
        unknown.get("kind").and_then(|v| v.as_str()),
        Some("provider-config")
    );
}

/// **The anti-vacuity proof.** A gate that cannot fail is worse than no gate, so
/// this test shows the thing the other three depend on: the child's validator is
/// LIVE, and a payload that violates the contract is REJECTED (logged, and no
/// session started). The bytes are written raw because the typed production writer
/// cannot construct an invalid command — which is the point: the tests above pass
/// because the core's payload survived a real validator, not because the sidecar
/// accepts anything.
#[tokio::test]
async fn a_contract_violating_command_is_rejected_by_the_live_sidecar() {
    let mut boundary = Boundary::boot();
    let scratch = boundary.scratch();
    // Same command as the happy path, with ONE field out of contract (`kind`).
    let line = serde_json::json!({
        "type": "start-session",
        "prompt": "replay the build transcript",
        "model": "replay-fixture",
        "cwd": scratch.to_string_lossy(),
        "kind": "not-a-task-kind",
    })
    .to_string();
    boundary.write_raw_line(&line).await;

    boundary
        .wait_for_stderr("invalid command", Duration::from_secs(10))
        .await;
    boundary
        .expect_silence("session-started", Duration::from_millis(750), |e| {
            matches!(e, NightcoreEvent::SessionStarted { .. })
        })
        .await;
}
