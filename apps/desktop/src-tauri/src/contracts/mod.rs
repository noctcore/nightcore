//! The typed mirror of the `@nightcore/contracts` zod spine, and its conformance
//! drift guard.
//!
//! [`generated`] is emitted by `tools/codegen/gen-rust-contracts.ts` from the zod
//! schemas (`bun run codegen:contracts`); it must never be edited by hand. Two
//! guards keep the Rust and TS sides from silently drifting at the sidecar NDJSON
//! boundary:
//!
//!  1. **Regenerate-and-diff** (`bun run codegen:contracts --check`, CI): the
//!     committed `generated.rs` / `fixtures.json` must equal what the emitter
//!     produces from the live zod source.
//!  2. **Conformance test** (this module, `cargo test`): every command and event
//!     variant's representative wire payload — produced by PARSING through the zod
//!     schema, so the fixtures are tied to the source — must deserialize into the
//!     generated type, and each command must round-trip back to the exact wire
//!     JSON (correct `type` literal, camelCase keys, absent optionals omitted).
//!
//! A zod field rename, retype, or enum-value change therefore fails LOUDLY: the
//! `--check` guard flags the generation side, and `cargo test` flags any payload
//! the regenerated types no longer accept.

mod generated;
pub use generated::*;

// The hand-written ts-rs `TaskKind` (the Rust→TS source for `TaskKind.ts` + the
// type on `Task.kind`). Homed here — a wire/contract enum — but NOT glob-exported
// at the module root: `pub use generated::*` already binds `contracts::TaskKind`
// to the zod→Rust wire enum. Reached via `crate::contracts::task_kind::TaskKind`
// and back-compat re-exported at `crate::task::TaskKind` (issue #17 phase A.3b).
pub(crate) mod task_kind;

// The circuit-breaker immediate-trip classifier lives in a sibling so this module
// stays a manifest (issue #17 phase D); re-exported so `crate::contracts::
// trips_breaker_immediately` resolves unchanged for the sidecar reader.
mod breaker;
pub(crate) use breaker::trips_breaker_immediately;

// The inverse direction — Rust serde structs → the web's TS bindings (`ts-rs`) —
// lives in the top-rank `crate::bindings` module (issue #17 phase A.4): the ts-rs
// aggregator references types across every tier, so it can't live in this rank-1
// leaf. Keeping it out is what lets `contracts` be an exemption-free leaf.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The category-based branch the sidecar reader and the orchestration breaker
    /// both key off: `auth` and `disk-full` stop the loop at once; every transient
    /// category stays windowed. Lives beside [`trips_breaker_immediately`] now that
    /// the classifier is a rank-1 contract, not an orchestration import.
    #[test]
    fn category_branch_decides_immediate_vs_windowed() {
        assert!(trips_breaker_immediately(ErrorCategory::Auth));
        assert!(trips_breaker_immediately(ErrorCategory::DiskFull));
        assert!(!trips_breaker_immediately(ErrorCategory::RateLimit));
        assert!(!trips_breaker_immediately(ErrorCategory::RunnerCrash));
        assert!(!trips_breaker_immediately(ErrorCategory::Unknown));
        assert!(!trips_breaker_immediately(ErrorCategory::ResourceExhausted));
    }

    /// The fixtures emitted alongside `generated.rs`: one wire payload per
    /// command/event variant, produced by parsing a representative input through
    /// the zod schema (defaults applied, shape validated against the live source).
    const FIXTURES: &str = include_str!("fixtures.json");

    fn fixtures() -> Value {
        serde_json::from_str(FIXTURES).expect("fixtures.json is valid JSON")
    }

    /// Normalize a JSON tree for wire-equality comparison: collapse every number to
    /// its `f64` value so an integer-valued `f64` field (`maxBudgetUsd: 5`) compares
    /// equal to its re-serialized form (`5.0`). On the JSON wire `5` and `5.0` are
    /// the same number (JS has one number type), so this is the correct boundary
    /// semantics — yet a string-vs-number drift or a key rename still fails, since
    /// only numeric representation is normalized, never types or keys.
    fn normalize(v: &Value) -> Value {
        match v {
            Value::Number(n) => {
                let f = n.as_f64().expect("json number is representable as f64");
                Value::from(f)
            }
            Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, val)| (k.clone(), normalize(val)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// Every command fixture must deserialize into the generated `SurfaceCommand`
    /// and round-trip back to the EXACT wire JSON it came from. Round-trip is the
    /// strong assertion: it proves the `type` discriminator literal, the camelCase
    /// key renames, the numeric types, and the nested `PermissionDecision` tag all
    /// match the zod source. A drift in any of those makes a fixture fail here.
    #[test]
    fn every_command_variant_round_trips() {
        let commands = fixtures();
        let commands = commands
            .get("commands")
            .and_then(Value::as_object)
            .expect("fixtures.commands is an object");
        assert_eq!(
            commands.len(),
            17,
            "all 17 SurfaceCommand variants must have a fixture"
        );
        for (tag, wire) in commands {
            let cmd: SurfaceCommand = serde_json::from_value(wire.clone())
                .unwrap_or_else(|e| panic!("command `{tag}` failed to deserialize: {e}"));
            let reser = serde_json::to_value(&cmd)
                .unwrap_or_else(|e| panic!("command `{tag}` failed to serialize: {e}"));
            assert_eq!(
                normalize(&reser),
                normalize(wire),
                "command `{tag}` did not round-trip to its wire shape"
            );
        }
    }

    /// Every query fixture must deserialize into the generated `SurfaceQuery` and
    /// round-trip back to its wire JSON. Queries are the request side of the
    /// request/reply session protocol the Rust core SERIALIZES; the round-trip pins
    /// the `requestId`/`sdkSessionId` keys and the `tag: null`-vs-absent shapes.
    #[test]
    fn every_query_variant_round_trips() {
        let queries = fixtures();
        let queries = queries
            .get("queries")
            .and_then(Value::as_object)
            .expect("fixtures.queries is an object");
        assert_eq!(
            queries.len(),
            7,
            "all 7 SurfaceQuery variants must have a fixture"
        );
        for (tag, wire) in queries {
            let query: SurfaceQuery = serde_json::from_value(wire.clone())
                .unwrap_or_else(|e| panic!("query `{tag}` failed to deserialize: {e}"));
            let reser = serde_json::to_value(&query)
                .unwrap_or_else(|e| panic!("query `{tag}` failed to serialize: {e}"));
            assert_eq!(
                normalize(&reser),
                normalize(wire),
                "query `{tag}` did not round-trip to its wire shape"
            );
        }
    }

    /// Every event fixture must deserialize into the generated `NightcoreEvent` and
    /// round-trip back to its wire JSON. Events are the deserialize/forward side of
    /// the boundary; the round-trip pins the field set so a renamed/retyped event
    /// field fails here even though the live reader forwards the raw `Value`.
    #[test]
    fn every_event_variant_round_trips() {
        let events = fixtures();
        let events = events
            .get("events")
            .and_then(Value::as_object)
            .expect("fixtures.events is an object");
        assert_eq!(
            events.len(),
            41,
            "all 41 NightcoreEvent variants must have a fixture"
        );
        for (tag, wire) in events {
            let event: NightcoreEvent = serde_json::from_value(wire.clone())
                .unwrap_or_else(|e| panic!("event `{tag}` failed to deserialize: {e}"));
            let reser = serde_json::to_value(&event)
                .unwrap_or_else(|e| panic!("event `{tag}` failed to serialize: {e}"));
            assert_eq!(
                normalize(&reser),
                normalize(wire),
                "event `{tag}` did not round-trip to its wire shape"
            );
        }
    }

    /// A `start-session` with every optional absent must serialize with those keys
    /// OMITTED (not `null`). The sidecar's zod `.optional()` validation rejects an
    /// explicit `null`, so absent-optional omission is load-bearing: this is the
    /// exact property the typed migration relies on.
    #[test]
    fn absent_optionals_are_omitted_not_null() {
        let cmd = SurfaceCommand::StartSession {
            prompt: "p".into(),
            model: None,
            effort: None,
            autonomy: None,
            cwd: None,
            kind: None,
            max_turns: None,
            max_budget_usd: None,
            resume_session_id: None,
            mcp_servers: None,
            append_context_pack: None,
            harness_policy: None,
            ledger_path: None,
            sandbox_writes: None,
            images: None,
        };
        let wire = serde_json::to_value(&cmd).expect("serializes");
        let obj = wire.as_object().expect("an object");
        assert_eq!(
            obj.get("type").and_then(Value::as_str),
            Some("start-session")
        );
        assert_eq!(obj.get("prompt").and_then(Value::as_str), Some("p"));
        for absent in [
            "model",
            "effort",
            "autonomy",
            "cwd",
            "kind",
            "maxTurns",
            "maxBudgetUsd",
            "resumeSessionId",
            "mcpServers",
            "appendContextPack",
            "harnessPolicy",
            "ledgerPath",
            "sandboxWrites",
            "images",
        ] {
            assert!(
                !obj.contains_key(absent),
                "absent optional `{absent}` must be omitted, not serialized as null"
            );
        }
        // Exactly the discriminator + the one required field remain.
        assert_eq!(obj.len(), 2, "only `type` and `prompt` survive: {obj:?}");
    }

    /// A bare `approve-permission` allow (no input rewrite) must serialize to the
    /// minimal `{behavior:"allow"}` decision the engine accepts — `updatedInput`
    /// omitted, matching the pre-migration `json!` output for a bare allow.
    #[test]
    fn bare_allow_omits_updated_input() {
        let cmd = SurfaceCommand::ApprovePermission {
            session_id: 7,
            request_id: "req-9".into(),
            decision: PermissionDecision::Allow {
                updated_input: None,
            },
        };
        let wire = serde_json::to_value(&cmd).expect("serializes");
        assert_eq!(
            wire,
            serde_json::json!({
                "type": "approve-permission",
                "sessionId": 7,
                "requestId": "req-9",
                "decision": { "behavior": "allow" }
            }),
            "a bare allow must omit updatedInput"
        );
    }

    /// The kebab-case `type` discriminator and camelCase field keys must match the
    /// wire exactly for a representative event (`session-completed`), including the
    /// nested camelCase `usage` struct keys.
    #[test]
    fn event_discriminator_and_camel_keys_match_wire() {
        let event = NightcoreEvent::SessionCompleted {
            session_id: 3,
            result: "ok".into(),
            cost_usd: 1.5,
            num_turns: 4,
            duration_ms: 0.0,
            usage: Some(SessionCompletedUsage {
                input_tokens: 1,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_creation_tokens: 4,
            }),
            // Absent for non-decompose sessions (skip_serializing_if), so the wire
            // assertion below is unaffected.
            proposed_subtasks: None,
        };
        let wire = serde_json::to_value(&event).expect("serializes");
        assert_eq!(
            wire,
            serde_json::json!({
                "type": "session-completed",
                "sessionId": 3,
                "result": "ok",
                "costUsd": 1.5,
                "numTurns": 4,
                "durationMs": 0.0,
                "usage": {
                    "inputTokens": 1,
                    "outputTokens": 2,
                    "cacheReadTokens": 3,
                    "cacheCreationTokens": 4
                }
            })
        );
    }

    /// An UNKNOWN/new event variant must NOT be representable as `NightcoreEvent`
    /// strictly — confirming why the live reader keeps forwarding the raw `Value`
    /// instead of deserializing into this enum (forward-compat for variants the web
    /// understands but Rust doesn't yet).
    #[test]
    fn unknown_event_variant_is_not_strictly_deserializable() {
        let unknown = serde_json::json!({
            "type": "future-event-rust-doesnt-know",
            "sessionId": 1,
            "somethingNew": true
        });
        assert!(
            serde_json::from_value::<NightcoreEvent>(unknown).is_err(),
            "an unknown event type must fail strict deserialization — the reader \
             must keep forwarding the raw Value, not parse into NightcoreEvent"
        );
    }

    /// The `issue-validation-completed` run-totals tail (`costUsd` required,
    /// `durationMs` `#[serde(default)]`, `usage` optional) and its nested
    /// `IssueValidationResult` (with several `skip_serializing_if`/`default` optionals)
    /// are exercised by the ALL-PRESENT representative fixture. This locks the INVERSE
    /// — a MINIMAL completed event: `durationMs` omitted (→ 0), `usage` omitted (→
    /// None), and a result with every optional absent — so the serde `default`/`skip`
    /// paths are proven against a real payload (matching the TS needs_clarification
    /// case the fixtures file can't carry, since it holds one payload per variant).
    #[test]
    fn issue_validation_completed_minimal_round_trips() {
        let wire = serde_json::json!({
            "type": "issue-validation-completed",
            "runId": "run-iv-min",
            "issueNumber": 7,
            "result": {
                "issueKind": "question",
                "verdict": "needs_clarification",
                "confidence": "low",
                "reasoning": "insufficient detail"
            },
            "costUsd": 0.0
        });
        let event: NightcoreEvent =
            serde_json::from_value(wire).expect("minimal completed event deserializes");
        match &event {
            NightcoreEvent::IssueValidationCompleted {
                cost_usd,
                duration_ms,
                usage,
                result,
                ..
            } => {
                assert_eq!(*cost_usd, 0.0);
                assert_eq!(
                    *duration_ms, 0.0,
                    "durationMs #[serde(default)] fills 0 when omitted"
                );
                assert!(usage.is_none(), "absent usage deserializes to None");
                assert!(
                    result.related_files.is_empty(),
                    "relatedFiles defaults to []"
                );
                assert!(result.missing_info.is_empty(), "missingInfo defaults to []");
                assert!(result.bug_confirmed.is_none());
                assert!(result.estimated_complexity.is_none());
                assert!(result.proposed_plan.is_none());
                assert!(result.pr_analysis.is_none());
            }
            other => panic!("expected IssueValidationCompleted, got {other:?}"),
        }

        // Re-serialize: durationMs materializes as 0.0 (default, no skip); the absent
        // optionals stay omitted (skip_serializing_if); the #[serde(default)] Vecs are
        // always present as [].
        let reser = serde_json::to_value(&event).expect("re-serializes");
        let obj = reser.as_object().expect("event is an object");
        assert_eq!(obj.get("costUsd").and_then(Value::as_f64), Some(0.0));
        assert_eq!(obj.get("durationMs").and_then(Value::as_f64), Some(0.0));
        assert!(
            !obj.contains_key("usage"),
            "absent usage stays omitted, not null"
        );
        let result = obj
            .get("result")
            .and_then(Value::as_object)
            .expect("result is an object");
        for absent in [
            "bugConfirmed",
            "estimatedComplexity",
            "proposedPlan",
            "prAnalysis",
        ] {
            assert!(
                !result.contains_key(absent),
                "absent optional `{absent}` must stay omitted, not null"
            );
        }
        assert_eq!(result.get("relatedFiles"), Some(&serde_json::json!([])));
        assert_eq!(result.get("missingInfo"), Some(&serde_json::json!([])));
    }

    /// Parity guard for the DOUBLE-DEFINED `TaskKind`.
    ///
    /// `TaskKind` is authored three times with no mechanical cross-check between
    /// the two Rust copies: the zod schema, the codegen'd
    /// [`generated::TaskKind`](super::generated) (zod→Rust, its stable name matched
    /// by value-set in `tools/codegen/gen-rust-contracts.ts`'s `ENUM_NAMES`), and
    /// the hand-written [`task_kind::TaskKind`](super::task_kind) (Rust→ts-rs→web).
    /// The `codegen:contracts --check` guard covers zod↔generated; this test covers
    /// generated↔hand-written, so the whole chain is guarded and a kind added on
    /// only one side reds the gate. Each enum's wire vocabulary is built from an EXHAUSTIVE
    /// match, so a newly-added variant also fails to COMPILE here until its arm is
    /// added — the array beside it must gain the same variant in the same edit.
    #[test]
    fn task_kind_variants_match_between_generated_and_store() {
        use std::collections::BTreeSet;

        // zod→Rust side: wire string via serde (what the sidecar validates against).
        fn generated_wire() -> BTreeSet<String> {
            use super::generated::TaskKind as K;
            [K::Build, K::Research, K::Review, K::Decompose, K::Tdd]
                .into_iter()
                .map(|k| {
                    // Exhaustiveness tripwire: a new codegen'd variant breaks this
                    // match (and the array above it) until it is added.
                    match k {
                        K::Build | K::Research | K::Review | K::Decompose | K::Tdd => {}
                    }
                    serde_json::to_value(k)
                        .expect("TaskKind serializes")
                        .as_str()
                        .expect("TaskKind is a string enum")
                        .to_owned()
                })
                .collect()
        }

        // Rust→ts-rs side: wire string via the hand-written enum's own `as_wire()`.
        fn store_wire() -> BTreeSet<String> {
            use super::task_kind::TaskKind as K;
            [K::Build, K::Research, K::Review, K::Decompose, K::Tdd]
                .into_iter()
                .map(|k| {
                    match k {
                        K::Build | K::Research | K::Review | K::Decompose | K::Tdd => {}
                    }
                    k.as_wire().to_owned()
                })
                .collect()
        }

        assert_eq!(
            generated_wire(),
            store_wire(),
            "generated::TaskKind and contracts::task_kind::TaskKind carry different \
             variant/wire sets — adding a task kind touches zod + ENUM_NAMES + the \
             contracts task_kind enum + as_wire(); one site was missed."
        );
    }

    /// Single-source guard for the `nc:*` Tauri event channel names (issue #44).
    ///
    /// Channel names are authored ONCE — the `@nightcore/contracts` `CHANNELS`
    /// registry — and emitted into [`generated::NIGHTCORE_CHANNELS`](super::generated)
    /// by `tools/codegen/gen-rust-contracts.ts` (so a rename in the source reds the
    /// `codegen-drift` gate). The runtime consts, however, are scattered across five
    /// modules (`sidecar`, `store/task`, `commands`, `orchestration`, `workflow/pr_fix`)
    /// because each lives beside its emitter. This test maps every registry symbol to
    /// its runtime const and asserts the whole set agrees with the generated registry,
    /// so a channel renamed, added, or removed on ONLY one tier fails here. The web
    /// tier can't drift — its bridge subscribes via `CHANNELS.*` directly.
    #[test]
    fn channel_consts_match_generated_registry() {
        use std::collections::BTreeMap;

        let registry: BTreeMap<&str, &str> = NIGHTCORE_CHANNELS.iter().copied().collect();

        // Every runtime `*_EVENT` const, keyed by its `CHANNELS` registry symbol.
        let runtime: BTreeMap<&str, &str> = [
            ("session", crate::sidecar::SESSION_EVENT),
            ("permission", crate::sidecar::PERMISSION_EVENT),
            ("question", crate::sidecar::QUESTION_EVENT),
            ("insight", crate::sidecar::INSIGHT_EVENT),
            ("harness", crate::sidecar::HARNESS_EVENT),
            ("scorecard", crate::sidecar::SCORECARD_EVENT),
            ("prReview", crate::sidecar::PRREVIEW_EVENT),
            ("issueTriage", crate::sidecar::ISSUE_TRIAGE_EVENT),
            ("task", crate::task::TASK_EVENT),
            ("project", crate::commands::project::PROJECT_EVENT),
            ("loop", crate::orchestration::coordinator::LOOP_EVENT),
            ("prFix", crate::workflow::pr_fix::PRFIX_EVENT),
        ]
        .into_iter()
        .collect();

        assert_eq!(
            runtime, registry,
            "the scattered Rust nc:* channel consts drifted from the \
             @nightcore/contracts CHANNELS registry (generated::NIGHTCORE_CHANNELS): a \
             channel was renamed, added, or removed on only one tier. Update CHANNELS, \
             run `bun run codegen:contracts`, and fix the matching *_EVENT const so the \
             registry, the runtime consts, and the web bridge all agree."
        );
    }
}
