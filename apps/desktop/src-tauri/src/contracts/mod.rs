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

// The inverse direction: Rust serde structs → the web's TS bindings (`ts-rs`).
// Test-only — the `#[ts(export)]` codegen + its drift guard run under `cargo test`,
// never in the shipped binary.
#[cfg(test)]
mod ts_bindings;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

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
            13,
            "all 13 SurfaceCommand variants must have a fixture"
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
            6,
            "all 6 SurfaceQuery variants must have a fixture"
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
            30,
            "all 30 NightcoreEvent variants must have a fixture"
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
            permission_mode: None,
            cwd: None,
            kind: None,
            max_turns: None,
            max_budget_usd: None,
            resume_session_id: None,
            mcp_servers: None,
            append_context_pack: None,
            harness_policy: None,
            ledger_path: None,
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
            "permissionMode",
            "cwd",
            "kind",
            "maxTurns",
            "maxBudgetUsd",
            "resumeSessionId",
            "mcpServers",
            "appendContextPack",
            "harnessPolicy",
            "ledgerPath",
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
}
