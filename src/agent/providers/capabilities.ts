// --- Provider capability matrix ---
// Used to warn users when an agent's config requires features
// the selected provider doesn't support.

export interface ProviderCapabilities {
  streaming: boolean
  tools: boolean
  vision: boolean
  thinking: boolean
  maxContext: number
  /** Can be made to return a value matching a schema, rather than prose the
   *  caller has to parse. False does NOT mean "no structured output" — it
   *  means no *guarantee*, so callers fall back to JSON-in-text plus a
   *  correction round. The claude-code CLI on an OAuth credential is the
   *  case that matters: ClaudeCodeProvider.generateRaw() throws there. */
  structuredOutput: boolean
  /** Exposes per-token logprobs. The only source of a probability that is
   *  the model's own posterior rather than a number it wrote out. */
  logprobs: boolean
}

export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  // structuredOutput is false here on purpose. ClaudeCodeProvider can force
  // a tool on an api-key credential but throws on OAuth ("generateRaw() not
  // available for OAuth/CLI mode"), and this matrix is static — it cannot
  // see which credential an operator has. False is the safe default: a
  // caller that believes a guarantee it doesn't have crashes on the
  // critical path, whereas a caller that falls back to JSON-in-text only
  // spends a correction round.
  "claude-code": {
    streaming: true,
    tools: true,
    vision: true,
    thinking: true,
    maxContext: 1_000_000,
    structuredOutput: false,
    logprobs: false,
  },
  claude: {
    streaming: true,
    tools: true,
    vision: true,
    thinking: true,
    maxContext: 1_000_000,
    structuredOutput: true,
    logprobs: false,
  },
  openai: {
    streaming: true,
    tools: true,
    vision: true,
    thinking: false,
    maxContext: 128_000,
    structuredOutput: true,
    logprobs: true,
  },
  deepseek: {
    streaming: true,
    tools: true,
    vision: false,
    thinking: true,
    maxContext: 128_000,
    structuredOutput: true,
    logprobs: true,
  },
  ollama: {
    streaming: true,
    tools: false,
    vision: false,
    thinking: false,
    maxContext: 32_000,
    structuredOutput: false,
    logprobs: false,
  },
  demo: {
    streaming: true,
    tools: false,
    vision: false,
    thinking: false,
    maxContext: 8_000,
    structuredOutput: false,
    logprobs: false,
  },
  // An OpenAI-compatible endpoint behind providers.<name>.baseUrl. What it
  // supports depends entirely on what is running there, so claim nothing.
  custom: {
    streaming: true,
    tools: false,
    vision: false,
    thinking: false,
    maxContext: 32_000,
    structuredOutput: false,
    logprobs: false,
  },
}

/**
 * Check provider capabilities and return warnings for missing features.
 */
export function checkCapabilities(
  providerName: string,
  requiredFeatures?: string[],
): string[] {
  const caps = PROVIDER_CAPABILITIES[providerName]
  if (!caps) {
    return [`Unknown provider "${providerName}" — capabilities unknown`]
  }

  if (!requiredFeatures?.length) return []

  const warnings: string[] = []
  const missing: string[] = []

  for (const feature of requiredFeatures) {
    if (feature in caps && !(caps as any)[feature]) {
      missing.push(feature)
    }
  }

  if (missing.length) {
    warnings.push(
      `Provider "${providerName}" lacks: ${missing.join(", ")}. Some features will be degraded.`,
    )
  }

  return warnings
}
