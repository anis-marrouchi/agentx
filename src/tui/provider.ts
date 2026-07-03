// Map an agent's tier (+ model) to the underlying provider/command that
// actually runs it, so the UI reflects reality — agentx is provider-agnostic,
// not Claude-only. The `tier` decides the spawn path; `model` disambiguates
// the orchestrator tier's backend.

export interface ProviderInfo {
  id: "claude" | "codex" | "anthropic" | "deepseek" | "openai" | "gemini" | "orchestrator" | "unknown"
  /** Short label shown in the UI, e.g. "claude". */
  label: string
  /** The underlying command/SDK, e.g. "claude", "codex", "@anthropic-ai/sdk". */
  command: string
  /** Badge accent color (per provider — distinct from the agentx accent). */
  color: string
  /** A small mark for the badge. */
  glyph: string
}

export function resolveProvider(tier: string, model?: string): ProviderInfo {
  const m = (model || "").toLowerCase()
  switch (tier) {
    case "claude-code":
      return { id: "claude", label: "claude", command: "claude", color: "yellow", glyph: "✦" }
    case "codex-cli":
      return { id: "codex", label: "codex", command: "codex", color: "green", glyph: "✳" }
    case "sdk":
      return { id: "anthropic", label: "anthropic", command: "@anthropic-ai/sdk", color: "yellow", glyph: "✦" }
    case "orchestrator": {
      if (m.includes("deepseek")) return { id: "deepseek", label: "deepseek", command: "deepseek", color: "blue", glyph: "◆" }
      if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("openai")) return { id: "openai", label: "openai", command: "openai", color: "cyan", glyph: "◆" }
      if (m.includes("gemini")) return { id: "gemini", label: "gemini", command: "gemini", color: "magenta", glyph: "◆" }
      if (m.includes("claude")) return { id: "claude", label: "claude", command: "anthropic", color: "yellow", glyph: "✦" }
      return { id: "orchestrator", label: "orchestrator", command: tier, color: "gray", glyph: "◆" }
    }
    default:
      return { id: "unknown", label: tier || "agent", command: tier || "", color: "gray", glyph: "◆" }
  }
}

/** Strip a provider prefix from a model id for compact display
 *  (claude-opus-4-8 → opus-4-8, gpt-5-codex → 5-codex). */
export function shortModel(model?: string): string {
  if (!model) return ""
  return model.replace(/^(claude|gpt|gemini|deepseek|anthropic)-/i, "")
}
