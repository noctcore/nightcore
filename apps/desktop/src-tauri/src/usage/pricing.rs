//! Bundled per-model pricing for the popover-only local cost ESTIMATE (spec §3.8).
//!
//! These are OUR OWN approximate tables (USD per 1M tokens), matched by model-id
//! substring. The result is always labeled "≈ approximate" — an estimate from local
//! session logs, NOT a bill. An unknown model contributes nothing (no fabricated
//! cost), so a new/renamed model degrades to a token-only total rather than a wrong
//! dollar figure.

/// USD price per 1,000,000 tokens for one model, per usage lane.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ModelPricing {
    pub(crate) input: f64,
    pub(crate) output: f64,
    pub(crate) cache_read: f64,
    pub(crate) cache_creation: f64,
}

impl ModelPricing {
    /// The USD cost of a token bundle at this model's rates.
    pub(crate) fn cost_usd(
        &self,
        input: u64,
        output: u64,
        cache_read: u64,
        cache_creation: u64,
    ) -> f64 {
        (input as f64 * self.input
            + output as f64 * self.output
            + cache_read as f64 * self.cache_read
            + cache_creation as f64 * self.cache_creation)
            / 1_000_000.0
    }
}

// Approximate public list prices (USD / 1M tokens). Estimates only.
const OPUS: ModelPricing = ModelPricing {
    input: 15.0,
    output: 75.0,
    cache_read: 1.5,
    cache_creation: 18.75,
};
const SONNET: ModelPricing = ModelPricing {
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_creation: 3.75,
};
const HAIKU: ModelPricing = ModelPricing {
    input: 0.8,
    output: 4.0,
    cache_read: 0.08,
    cache_creation: 1.0,
};
const GPT5: ModelPricing = ModelPricing {
    input: 1.25,
    output: 10.0,
    cache_read: 0.125,
    cache_creation: 1.25,
};

/// Resolve approximate pricing for a model id by family substring. `None` for an
/// unknown model — the caller then contributes tokens but no dollars.
pub(crate) fn price_for(model_id: &str) -> Option<ModelPricing> {
    let m = model_id.to_ascii_lowercase();
    if m.contains("opus") {
        Some(OPUS)
    } else if m.contains("sonnet") {
        Some(SONNET)
    } else if m.contains("haiku") {
        Some(HAIKU)
    } else if m.contains("gpt-5") || m.contains("codex") {
        Some(GPT5)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_families_by_substring() {
        assert!(price_for("claude-opus-4-8").is_some());
        assert!(price_for("claude-sonnet-4-6").is_some());
        assert!(price_for("claude-haiku-4-5").is_some());
        assert!(price_for("gpt-5-codex").is_some());
        assert!(price_for("mystery-model").is_none());
    }

    #[test]
    fn cost_scales_per_million() {
        // 1M input tokens on Opus = $15 exactly.
        let p = price_for("claude-opus-4-8").unwrap();
        assert!((p.cost_usd(1_000_000, 0, 0, 0) - 15.0).abs() < 1e-9);
        // Output is priced separately.
        assert!((p.cost_usd(0, 1_000_000, 0, 0) - 75.0).abs() < 1e-9);
    }
}
