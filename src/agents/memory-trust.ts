// --- What extracted memory may keep, and what it may inject ---
//
// Facts are extracted from conversations after every reply and injected
// into later tasks of the same agent, in any chat. Three rules keep that
// from becoming a leak or a persistent prompt injection:
//
//   1. Secrets are never stored or injected. A credential pasted into one
//      chat must not follow the agent into every other chat.
//   2. Every fact records how far its source can be trusted, from the
//      channel it came through.
//   3. Facts from external sources (webhooks, public widgets, anything
//      unknown) are held out of injection until someone approves them:
//      anybody can write to those channels.
//
// Pure functions, unit tested.

export type SourceTrust =
  /** Only the operator can reach it: CLI, dashboard, local voice and TUI. */
  | "operator"
  /** Authenticated people or peers: allow-listed chat senders, forge
   *  project members, mesh callers. */
  | "internal"
  /** Anyone can write to it. */
  | "external"

export type FactReview = "held" | "approved" | "rejected"

const OPERATOR_CHANNELS = new Set([
  "cli", "chat-cli", "exec", "tui", "dashboard", "admin", "test-drive",
  "workflow-editor", "voice", "opencode", "mcp", "ntfy",
])

/** People behind an allow-list or project membership, mesh peers, and
 *  this node's own automation. New extraction skips the machine channels
 *  (cron, workflow, a2a) anyway; older facts from them keep working. */
const INTERNAL_CHANNELS = new Set([
  "telegram", "whatsapp", "slack", "discord", "gitlab", "github",
  "api", "a2a", "mesh", "subagent", "compaction",
  "cron", "workflow", "business", "heartbeat", "selftest",
])

/** Trust for a fact's source channel. Channels carry a node suffix
 *  ("telegram@peer-server"). Anything else, including web-chat,
 *  public-api, webhooks and channels added later, is external. */
export function trustForChannel(channel: string | undefined): SourceTrust {
  const base = (channel ?? "").toLowerCase().split("@")[0]
  if (OPERATOR_CHANNELS.has(base)) return "operator"
  if (INTERNAL_CHANNELS.has(base)) return "internal"
  return "external"
}

// Shapes of credentials. Deliberately specific: each pattern is a known
// token format or an explicit assignment, so ordinary prose about "the
// token" or "a password reset" is not caught.
const SECRET_PATTERNS: RegExp[] = [
  /\bglpat-[A-Za-z0-9_-]{16,}/,                        // GitLab PAT
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,                     // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/,                      // Anthropic
  /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/,                  // OpenAI-style
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,                   // Slack
  /\bAKIA[0-9A-Z]{16}\b/,                             // AWS access key
  /\bAIza[0-9A-Za-z_-]{35}\b/,                        // Google API key
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,                   // Telegram bot token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token)\s*[:=]\s*["']?[^\s"',;]{8,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{6,}@/i,  // URL with user:password@
]

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text))
}

/** The fields of a stored fact this module reads. Older facts have no
 *  trust or review; trust then comes from their source channel. */
export interface FactTrustFields {
  category: string
  content: string
  source: { channel: string; trust?: SourceTrust }
  review?: FactReview
}

export function factTrust(f: FactTrustFields): SourceTrust {
  return f.source.trust ?? trustForChannel(f.source.channel)
}

/** Whether a new fact from this source waits for review before use. */
export function initialReview(trust: SourceTrust): FactReview | undefined {
  return trust === "external" ? "held" : undefined
}

/** Whether a stored fact may be injected into a prompt. */
export function isInjectable(f: FactTrustFields): boolean {
  if (f.category === "secret" || containsSecret(f.content)) return false
  if (f.review === "rejected" || f.review === "held") return false
  if (factTrust(f) === "external") return f.review === "approved"
  return true
}
