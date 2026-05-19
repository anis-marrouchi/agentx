import type { AgentProvider } from "./types"
import { ClaudeProvider } from "./claude"
import { ClaudeCodeProvider } from "./claude-code"
import { OpenAIProvider } from "./openai"
import { loadAuthConfig } from "@/utils/auth-store"

// `deepseek` is a label on top of the OpenAI-compatible provider — it
// resolves to OpenAIProvider with the DeepSeek baseUrl + DEEPSEEK_API_KEY
// so users can declare `provider: "deepseek"` on an agent without having to
// also fiddle with OPENAI_BASE_URL. Same pattern for any other preset.
export type ProviderName = "claude-code" | "claude" | "openai" | "deepseek" | "ollama" | "custom"

const DEEPSEEK_PRESET = {
  baseUrl: "https://api.deepseek.com/v1",
  envKey: "DEEPSEEK_API_KEY",
}

export interface CreateProviderOptions {
  /** Toggle DeepSeek thinking-mode (`reasoning_content` blocks). Default
   *  `true` for DeepSeek baseUrls. Wire this from
   *  `providers.<name>.thinking` in agentx.json. */
  thinking?: boolean
}

export function createProvider(
  name: ProviderName = "claude-code",
  apiKey?: string,
  opts: CreateProviderOptions = {},
): AgentProvider {
  // Auto-detect provider from stored config when using the default
  let resolvedName = name
  if (name === "claude-code" && !apiKey) {
    const stored = loadAuthConfig()
    if (stored) {
      resolvedName = stored.provider
    }
  }

  switch (resolvedName) {
    case "claude-code":
      return new ClaudeCodeProvider()
    case "claude":
      return new ClaudeProvider(apiKey)
    case "openai":
      // OpenAI-compatible. Defaults to api.openai.com/v1 + OPENAI_API_KEY;
      // override the host via OPENAI_BASE_URL so the same class talks to
      // any compatible backend (vLLM, OpenRouter, Together, llama.cpp).
      return new OpenAIProvider(apiKey, undefined, { thinking: opts.thinking })
    case "deepseek":
      // Convenience preset — forces the DeepSeek baseUrl and pulls the key
      // from DEEPSEEK_API_KEY (falls back to apiKey arg or OPENAI_API_KEY).
      return new OpenAIProvider(
        apiKey || process.env[DEEPSEEK_PRESET.envKey] || process.env.OPENAI_API_KEY,
        DEEPSEEK_PRESET.baseUrl,
        { thinking: opts.thinking },
      )
    case "ollama":
      throw new Error(
        "Ollama provider coming soon. Workaround: set provider to 'openai' with OPENAI_BASE_URL=http://localhost:11434/v1 (Ollama exposes an OpenAI-compatible endpoint). Or contribute at github.com/anis-marrouchi/agentx",
      )
    default:
      throw new Error(`Unknown provider: ${resolvedName}. Supported: claude-code, claude, openai, deepseek`)
  }
}

export { ClaudeProvider } from "./claude"
export { ClaudeCodeProvider } from "./claude-code"
export { OpenAIProvider } from "./openai"
export type {
  AgentProvider,
  GenerationMessage,
  GenerationResult,
  GeneratedFile,
  ProviderOptions,
  StreamEvent,
  AnthropicMessage,
  ContentBlock,
  RawGenerationResult,
} from "./types"
