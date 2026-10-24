// --- What a usage_daily row cost, in dollars ---
//
// Shared by the Cost page (daemon/observability-panel.ts) and the monthly
// agent budget (agents/budget.ts), so the number an agent is held at is the
// number the owner sees on the Cost page.

// Anthropic public per-million-token rates. Same numbers
// src/observability/tracker.ts uses; duplicated here so this module stays
// independent of the in-process token tracker.
//
// "external" is a pricing-attribution stub for models we don't bill against
// the Anthropic spend — codex-cli routes through OpenAI, sdk agents may
// route through OpenAI / Bedrock / Vertex. Showing them at $0 here is the
// honest answer: this dashboard tracks Anthropic spend; cross-provider
// rollups belong on a separate surface that knows the OpenAI keys / bill.
export const RATE_PER_M: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  opus:     { input: 15,  output: 75,   cacheRead: 1.5,  cacheCreate: 18.75 },
  sonnet:   { input: 3,   output: 15,   cacheRead: 0.3,  cacheCreate: 3.75 },
  haiku:    { input: 0.25, output: 1.25, cacheRead: 0.025, cacheCreate: 0.3125 },
  external: { input: 0,   output: 0,    cacheRead: 0,    cacheCreate: 0 },
}
export function modelFamily(model: string): "opus" | "sonnet" | "haiku" | "external" {
  const m = (model || "").toLowerCase()
  if (m.includes("opus")) return "opus"
  if (m.includes("haiku")) return "haiku"
  if (m.includes("sonnet") || m.includes("claude")) return "sonnet"
  // Anything else — gpt-*, codex, gemini, llama, … — routed to the external
  // bucket so it doesn't masquerade as Sonnet spend on the dashboard.
  return "external"
}
export function rowCost(row: {
  model: string;
  input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_create_tokens: number;
  tier2_input_tokens?: number; tier2_output_tokens?: number;
  tier2_cache_read_tokens?: number; tier2_cache_create_tokens?: number;
}): number {
  const r = RATE_PER_M[modelFamily(row.model)]
  // Tier-2 columns ALSO live in input_tokens etc. (they're a subset, not a
  // disjoint count). The tier-2 multiplier (1.5×) is the additional charge.
  const base =
    (row.input_tokens / 1_000_000) * r.input +
    (row.output_tokens / 1_000_000) * r.output +
    (row.cache_read_tokens / 1_000_000) * r.cacheRead +
    (row.cache_create_tokens / 1_000_000) * r.cacheCreate
  const tier2Surcharge =
    ((row.tier2_input_tokens ?? 0) / 1_000_000) * r.input * 0.5 +
    ((row.tier2_output_tokens ?? 0) / 1_000_000) * r.output * 0.5 +
    ((row.tier2_cache_read_tokens ?? 0) / 1_000_000) * r.cacheRead * 0.5 +
    ((row.tier2_cache_create_tokens ?? 0) / 1_000_000) * r.cacheCreate * 0.5
  return base + tier2Surcharge
}
