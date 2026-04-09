// --- Agent Context Engine ---
//
// Structured, layered context with token budget management.
// Each context layer has a priority, max tokens, and rules.
//
// Layers (highest priority first):
//   1. Channel   — where the message came from + channel-specific rules
//   2. Scope     — group/personal/project + scope-specific constraints
//   3. Landscape — world model: team roster, channels, rules (cached at startup)
//   4. Identity  — who the agent is, what it can do
//   5. Intent    — what the user is asking about (extracted from message)
//   6. Artifacts — project, issue, MR, file references
//   7. History   — group conversation log or session history
//   8. Wiki      — relevant knowledge articles
//
// Token budget: each layer gets a max allocation. Total capped at configurable limit.
// Layers are rendered top-down; if budget exhausted, lower layers are truncated or skipped.

export interface ContextLayer {
  name: string
  priority: number       // lower = higher priority (1 = most important)
  maxTokens: number      // max tokens for this layer
  content: string        // rendered text
  tags: string[]         // metadata tags for filtering/matching
  rules?: string[]       // constraints/instructions specific to this layer
}

export interface ContextConfig {
  /** Total token budget for all context combined (default: 4000) */
  totalBudget: number
  /** Per-layer budgets override (layer name -> max tokens) */
  layerBudgets?: Record<string, number>
}

const DEFAULT_CONFIG: ContextConfig = {
  totalBudget: 4000,
  layerBudgets: {
    channel: 200,
    scope: 200,
    landscape: 350,
    identity: 200,
    intent: 200,
    artifacts: 500,
    history: 1200,
    wiki: 1000,
  },
}

// Rough estimate: 1 token ≈ 4 chars for English
const CHARS_PER_TOKEN = 4

export interface ContextInput {
  // Channel layer
  channel: string                    // "telegram", "whatsapp", "gitlab", "discord"
  channelScope?: "group" | "personal" | "project"

  // Bootstrap identity files (from workspace)
  bootstrapContext?: string          // from buildBootstrapContext()

  // Scope layer
  groupName?: string
  projectPath?: string               // "org/my-project"
  issueMR?: { type: string; iid: string; title: string }

  // Identity layer
  agentId: string
  agentName: string
  agentHandle?: string               // "@my_bot"
  systemPrompt?: string

  // Participants
  sender: string
  senderId?: string                  // platform user ID (e.g. Telegram user ID)
  senderUsername?: string            // platform username (e.g. @username)
  senderRole?: string                // "user", "agent:other-agent"

  // Landscape (cached world model from LandscapeBuilder)
  landscape?: string

  // Channel meta (verified facts from the channel adapter — prevents hallucination)
  channelMeta?: {
    agents?: Array<{ id: string; name: string; handle?: string }>
    project?: string
    issue?: { type: string; iid: string; title: string }
    facts?: string[]
  }

  // Artifacts
  mediaPath?: string
  mediaType?: string
  replyToText?: string

  // Memory (persistent cross-session facts)
  memoryContext?: string              // from MemoryStore.buildContext()

  // History
  groupHistory?: string              // from GroupLog.buildContext()
  sessionHistory?: string            // from SessionStore.buildHistoryContext()
  crossChatContext?: string           // from SessionStore.getCrossSessionSummary()

  // Wiki
  wikiContext?: string               // from WikiStore.buildContext()

  // Message
  message: string
}

/**
 * Build optimized context string from structured input.
 * Respects token budgets per layer and total cap.
 */
export function buildAgentContext(input: ContextInput, config: ContextConfig = DEFAULT_CONFIG): string {
  const layers = buildLayers(input, config)

  // Sort by priority (lower = first)
  layers.sort((a, b) => a.priority - b.priority)

  // Render within budget
  const parts: string[] = []
  let totalChars = 0
  const maxChars = config.totalBudget * CHARS_PER_TOKEN

  for (const layer of layers) {
    if (!layer.content) continue

    const layerMaxChars = layer.maxTokens * CHARS_PER_TOKEN
    const trimmed = layer.content.length > layerMaxChars
      ? layer.content.slice(0, layerMaxChars) + "..."
      : layer.content

    if (totalChars + trimmed.length > maxChars) {
      // Budget exhausted — add what fits or skip
      const remaining = maxChars - totalChars
      if (remaining > 100) {
        parts.push(trimmed.slice(0, remaining) + "...")
      }
      break
    }

    parts.push(trimmed)
    totalChars += trimmed.length
  }

  return parts.join("\n\n")
}

/**
 * Build individual context layers from input.
 */
function buildLayers(input: ContextInput, config: ContextConfig): ContextLayer[] {
  const budget = (name: string, fallback: number) =>
    config.layerBudgets?.[name] ?? fallback

  const layers: ContextLayer[] = []

  // 1. Channel layer
  layers.push(buildChannelLayer(input, budget("channel", 200)))

  // 2. Scope layer
  layers.push(buildScopeLayer(input, budget("scope", 200)))

  // 3. Landscape (cached world model — team, channels, rules)
  if (input.landscape) {
    layers.push({
      name: "landscape",
      priority: 3,
      maxTokens: budget("landscape", 350),
      content: input.landscape,
      tags: ["landscape", "world-model"],
    })
  }

  // 4. Identity (only first line of systemPrompt — agent already has CLAUDE.md)
  if (input.systemPrompt) {
    layers.push({
      name: "identity",
      priority: 4,
      maxTokens: budget("identity", 200),
      content: input.systemPrompt.split("\n")[0],
      tags: ["identity", input.agentId],
    })
  }

  // 4.5 Bootstrap identity files (SOUL.md, IDENTITY.md, USER.md, AGENTS.md)
  if (input.bootstrapContext) {
    layers.push({
      name: "bootstrap",
      priority: 4.5,
      maxTokens: budget("bootstrap", 500),
      content: input.bootstrapContext,
      tags: ["bootstrap", "identity", "personality"],
    })
  }

  // 5. Intent (extracted keywords from message)
  // Lightweight — just tag detection, not LLM-based
  const intentTags = extractIntentTags(input.message)
  if (intentTags.length) {
    layers.push({
      name: "intent",
      priority: 5,
      maxTokens: budget("intent", 200),
      content: `[Intent: ${intentTags.join(", ")}]`,
      tags: intentTags,
    })
  }

  // 6. Artifacts (media, reply-to, issue/MR context)
  const artifactLines: string[] = []
  if (input.replyToText) {
    artifactLines.push(`[Replying to]: ${input.replyToText.slice(0, 300)}`)
  }
  if (input.mediaPath) {
    artifactLines.push(`[Attached file: ${input.mediaPath}]`)
    artifactLines.push(`[File type: ${input.mediaType || "unknown"}]`)
    if (input.mediaType?.startsWith("image/")) artifactLines.push("Please view this image and respond to it.")
    else if (input.mediaType?.startsWith("audio/")) artifactLines.push("Please transcribe this audio and respond.")
  }
  if (input.issueMR) {
    artifactLines.push(`[${input.issueMR.type} #${input.issueMR.iid}: ${input.issueMR.title}]`)
  }
  if (artifactLines.length) {
    layers.push({
      name: "artifacts",
      priority: 6,
      maxTokens: budget("artifacts", 500),
      content: artifactLines.join("\n"),
      tags: ["artifacts", ...(input.mediaType ? ["media"] : [])],
    })
  }

  // 6.5 Agent memory (persistent cross-session facts from Haiku extraction)
  if (input.memoryContext) {
    layers.push({
      name: "memory",
      priority: 6.5,
      maxTokens: budget("memory", 600),
      content: input.memoryContext,
      tags: ["memory", "persistent"],
    })
  }

  // 7. History (group > session — prefer group if available)
  const history = input.groupHistory || input.sessionHistory
  if (history) {
    layers.push({
      name: "history",
      priority: 7,
      maxTokens: budget("history", 1200),
      content: history,
      tags: ["history", "conversation"],
    })
  }

  // 7b. Cross-chat context (bridges DM ↔ group amnesia)
  if (input.crossChatContext) {
    layers.push({
      name: "cross-chat",
      priority: 7,
      maxTokens: budget("cross-chat", 800),
      content: input.crossChatContext,
      tags: ["history", "cross-chat"],
    })
  }

  // 8. Wiki knowledge
  if (input.wikiContext) {
    layers.push({
      name: "wiki",
      priority: 8,
      maxTokens: budget("wiki", 1000),
      content: input.wikiContext,
      tags: ["wiki", "knowledge"],
    })
  }

  return layers
}

/**
 * Build channel-specific context with rules.
 */
function buildChannelLayer(input: ContextInput, maxTokens: number): ContextLayer {
  const lines: string[] = [`Channel: ${input.channel}`]
  const rules: string[] = []
  const tags = [input.channel]

  switch (input.channel) {
    case "telegram":
      if (input.agentHandle) lines.push(`Your handle: ${input.agentHandle}`)
      lines.push(`From: ${input.sender}`)
      if (input.senderId) lines.push(`Telegram user ID: ${input.senderId}`)
      if (input.senderUsername) lines.push(`Username: @${input.senderUsername}`)
      rules.push("Format responses using Telegram-compatible markdown")
      rules.push("Be brief — 2-4 sentences max for the main point. Humans scan, not read")
      rules.push("Lead with the action or answer, skip preamble")
      break

    case "whatsapp":
      lines.push(`From: ${input.sender}`)
      rules.push("Be brief — 2-3 sentences max. WhatsApp is mobile-first")
      rules.push("No rich formatting — plain text only")
      rules.push("Lead with the action or answer, skip preamble")
      break

    case "gitlab":
      lines.push(`From: ${input.sender}`)
      rules.push("Reply as a short, actionable GitLab comment — 3-5 lines for the main message")
      rules.push("Do NOT mention Telegram handles — they don't work on GitLab")
      rules.push("Do NOT delegate to other agents")
      rules.push("Reference issues with #IID and merge requests with !IID")
      rules.push("Put verbose details (logs, full commands, step-by-step) inside collapsible sections: <details><summary>Title</summary>\\n\\ncontent\\n</details>")
      rules.push("Never narrate what you are about to do — just do it and report the result")
      tags.push("code-review")
      break

    case "discord":
      lines.push(`From: ${input.sender}`)
      rules.push("Use Discord markdown for formatting")
      rules.push("Be brief — 2-4 sentences for the main point")
      break

    default:
      if (input.channel.startsWith("webhook:")) {
        rules.push("This is an automated event — respond with actionable steps")
        tags.push("webhook", "automated")
      }
  }

  if (rules.length) {
    lines.push("")
    lines.push("[Rules]")
    lines.push(...rules.map(r => `- ${r}`))
  }

  return { name: "channel", priority: 1, maxTokens, content: lines.join("\n"), tags, rules }
}

/**
 * Build scope context (group/personal/project).
 */
function buildScopeLayer(input: ContextInput, maxTokens: number): ContextLayer {
  const lines: string[] = []
  const tags: string[] = []

  if (input.channelScope === "group" && input.groupName) {
    lines.push(`Group: ${input.groupName}`)
    tags.push("group", input.groupName)
  } else if (input.channelScope === "project" && input.projectPath) {
    lines.push(`Project: ${input.projectPath}`)
    tags.push("project", input.projectPath)
  } else if (input.channelScope === "personal") {
    lines.push("Direct message")
    tags.push("dm")
  }

  // Inject verified channel metadata (prevents hallucination)
  if (input.channelMeta) {
    const meta = input.channelMeta
    if (meta.agents?.length) {
      lines.push(`[Verified bots in this chat: ${meta.agents.map(a => a.handle || a.name || a.id).join(", ")}]`)
      lines.push("Only mention these agents as group members — do NOT assume others are present.")
    }
    if (meta.project) {
      lines.push(`Project: ${meta.project}`)
    }
    if (meta.issue) {
      lines.push(`${meta.issue.type} #${meta.issue.iid}${meta.issue.title ? `: ${meta.issue.title}` : ""}`)
    }
    if (meta.facts?.length) {
      for (const fact of meta.facts) {
        lines.push(`• ${fact}`)
      }
    }
  }

  return { name: "scope", priority: 2, maxTokens, content: lines.join("\n"), tags }
}

/**
 * Extract intent tags from message (lightweight, no LLM).
 */
function extractIntentTags(message: string): string[] {
  const tags: string[] = []
  const lower = message.toLowerCase()

  // Action intents
  if (/deploy|push|release|ship/.test(lower)) tags.push("deployment")
  if (/review|check|look at|approve/.test(lower)) tags.push("review")
  if (/fix|bug|broken|error|issue/.test(lower)) tags.push("bugfix")
  if (/create|add|build|implement/.test(lower)) tags.push("feature")
  if (/test|spec|coverage/.test(lower)) tags.push("testing")
  if (/refactor|clean|improve/.test(lower)) tags.push("refactor")
  if (/docs|document|readme/.test(lower)) tags.push("docs")
  if (/security|vuln|auth|token/.test(lower)) tags.push("security")
  if (/perf|slow|optim|fast/.test(lower)) tags.push("performance")
  if (/status|update|progress|standup/.test(lower)) tags.push("status")
  if (/help|how|what|explain/.test(lower)) tags.push("question")

  // Domain intents
  if (/gitlab|merge|mr|issue|pipeline/.test(lower)) tags.push("gitlab")
  if (/seo|analytics|content|marketing/.test(lower)) tags.push("marketing")
  if (/infra|server|docker|k8s|devops/.test(lower)) tags.push("devops")

  return tags
}

/**
 * Estimate token count from text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}
