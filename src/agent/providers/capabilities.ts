// --- Provider capability matrix ---
// Used to warn users when an agent's config requires features
// the selected provider doesn't support.

export interface ProviderCapabilities {
  streaming: boolean
  tools: boolean
  vision: boolean
  thinking: boolean
  maxContext: number
}

export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  "claude-code": {
    streaming: true,
    tools: true,
    vision: true,
    thinking: true,
    maxContext: 1_000_000,
  },
  claude: {
    streaming: true,
    tools: true,
    vision: true,
    thinking: true,
    maxContext: 1_000_000,
  },
  openai: {
    streaming: true,
    tools: true,
    vision: true,
    thinking: false,
    maxContext: 128_000,
  },
  ollama: {
    streaming: true,
    tools: false,
    vision: false,
    thinking: false,
    maxContext: 32_000,
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
