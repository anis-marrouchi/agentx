// --- Agent Context Engine ---
//
// Structured, layered context with token budget management.
// Each context layer has a priority, max tokens, and rules.
//
// Layers (highest priority first):
//   1. Channel   — where the message came from + channel-specific rules
//   2. Scope     — group/personal/project + scope-specific constraints
//   3. Identity  — who the agent is, what it can do
//   4. Peers     — other agents available (only on channels that support delegation)
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
    identity: 300,
    peers: 400,
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

  // Scope layer
  groupName?: string
  projectPath?: string               // "mtgl/mtgl-system-v2"
  issueMR?: { type: string; iid: string; title: string }

  // Identity layer
  agentId: string
  agentName: string
  agentHandle?: string               // "@noqta_pm_mtgl_bot"
  systemPrompt?: string

  // Participants
  sender: string
  senderRole?: string                // "user", "agent:atlas"

  // Peers (other agents)
  peers?: Array<{ name: string; handle?: string; role?: string }>

  // Artifacts
  mediaPath?: string
  mediaType?: string
  replyToText?: string

  // History
  groupHistory?: string              // from GroupLog.buildContext()
  sessionHistory?: string            // from SessionStore.buildHistoryContext()

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

  // 3. Identity (only first line of systemPrompt — agent already has CLAUDE.md)
  if (input.systemPrompt) {
    layers.push({
      name: "identity",
      priority: 3,
      maxTokens: budget("identity", 300),
      content: input.systemPrompt.split("\n")[0],
      tags: ["identity", input.agentId],
    })
  }

  // 4. Peers (only on channels that support delegation)
  if (input.peers?.length && supportsDelgation(input.channel)) {
    layers.push(buildPeersLayer(input, budget("peers", 400)))
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
      rules.push("Format responses using Telegram-compatible markdown")
      rules.push("Keep responses concise for mobile reading")
      break

    case "whatsapp":
      lines.push(`From: ${input.sender}`)
      rules.push("Keep responses concise — WhatsApp is mobile-first")
      rules.push("No rich formatting — plain text only")
      break

    case "gitlab":
      lines.push(`From: ${input.sender}`)
      rules.push("Reply as a GitLab comment with GitLab-flavored markdown")
      rules.push("Do NOT mention Telegram handles (@noqta_*)")
      rules.push("Do NOT delegate to other agents")
      rules.push("Reference issues with #IID and merge requests with !IID")
      rules.push("Be specific and actionable — this is a code review context")
      tags.push("code-review")
      break

    case "discord":
      lines.push(`From: ${input.sender}`)
      rules.push("Use Discord markdown for formatting")
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

  return { name: "scope", priority: 2, maxTokens, content: lines.join("\n"), tags }
}

/**
 * Build peers layer (only for channels that support bot-to-bot).
 */
function buildPeersLayer(input: ContextInput, maxTokens: number): ContextLayer {
  const lines = ["[Team — mention to delegate]"]
  for (const peer of input.peers || []) {
    const handle = peer.handle ? ` (${peer.handle})` : ""
    const role = peer.role ? ` — ${peer.role}` : ""
    lines.push(`• ${peer.name}${handle}${role}`)
  }
  lines.push("Mention their handle to involve them.")
  return { name: "peers", priority: 4, maxTokens, content: lines.join("\n"), tags: ["peers", "team"] }
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
 * Channels that support agent delegation (bot-to-bot mentions).
 */
function supportsDelgation(channel: string): boolean {
  return channel === "telegram"
}

/**
 * Estimate token count from text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}
