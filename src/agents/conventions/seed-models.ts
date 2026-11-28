// --- The models each engine offers before any probe (#2349) ---
//
// The one place that names models for the pickers: the Settings model
// picker (hub/settings/agent-data.ts), the Hub composer (daemon/
// assistant-model.ts) and `agentx model show` (the sdk list). A CLI that
// can list its own models replaces its list with a real answer later (PR 2);
// this is what shows until then. The model check (engine-model.ts) does not
// read it: a hand-typed id the family rule accepts still runs.
//
// No imports beyond types: the Hub's browser bundle reads this file.
import type { ConventionTier } from "./types"

export interface SeedModel {
  /** The id the engine takes. */
  id: string
  /** The short name the Hub composer offers for it; absent: not offered there. */
  choice?: string
  label?: string
  hint?: string
}

export const SEED_MODELS: Record<ConventionTier, readonly SeedModel[]> = {
  "claude-code": [
    { id: "claude-opus-5-5", choice: "opus" },
    { id: "claude-sonnet-5-5", choice: "sonnet" },
    { id: "claude-haiku-5-5", choice: "haiku" },
    { id: "claude-fable-5-2" },
  ],
  // `codex debug models`, codex-cli 0.171.0, the ones it lists (27 Nov 2026).
  "codex-cli": [
    "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra",
    "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  ].map((id) => ({ id, choice: id })),
  // opencode reaches hundreds of provider/model ids; its list comes from the CLI (PR 2).
  opencode: [],
  // `agy models`, agy 1.5.19, the Gemini ones (28 Nov 2026). It also lists
  // Claude and GPT-OSS ids; the live list comes from the CLI (PR 2).
  "antigravity-cli": [
    "gemini-4-neon-high", "gemini-4-neon-medium", "gemini-4-carbon-high", "gemini-4-carbon-medium",
    "gemini-4-argon-medium", "gemini-4-hydrogen-medium", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
  ].map((id) => ({ id, choice: id })),
  // Anthropic API ids, for the engine that runs inside AgentX.
  sdk: [
    { id: "claude-sonnet-4-20250514", label: "anthropic/claude-sonnet-4", hint: "Claude Sonnet 4 · ctx 200k · recommended" },
    { id: "claude-opus-4-20250514", label: "anthropic/claude-opus-4-5", hint: "Claude Opus 4.5 · ctx 200k · reasoning" },
    { id: "claude-haiku-4-20250514", label: "anthropic/claude-haiku-4", hint: "Claude Haiku 4 · ctx 200k · fast" },
  ],
  orchestrator: [],
}

/** The seed list for an engine; empty for one AgentX does not know. */
export function seedModels(tier: string | undefined): readonly SeedModel[] {
  return (SEED_MODELS as Record<string, readonly SeedModel[]>)[String(tier ?? "")] ?? []
}
