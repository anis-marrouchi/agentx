import type { ChannelAdapter, IncomingMessage, OutgoingMessage, ChannelMeta } from "./types"
import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from "http"

// --- GitLab webhook channel adapter ---
//
// Receives GitLab webhook events (note/comment, issue, MR, push, pipeline)
// and routes @mention comments to agents. Agents reply as GitLab API comments.
//
// Config:
//   channels.gitlab:
//     enabled: true
//     webhookPort: 18810          # separate port for GitLab webhooks
//     webhookSecret: "secret"     # validates X-Gitlab-Token header
//     host: "https://gitlab.example.com"
//     token: "${GITLAB_TOKEN}"    # for posting comments back
//     routes:
//       - project: "org/my-project"
//         agent: "pm-agent"
//       - project: "*"
//         agent: "default-agent"   # default for unmatched projects

export interface GitLabRoute {
  project: string  // "group/project" or "*" for default
  agent: string
}

export interface GitLabAgentMapping {
  agentId: string
  gitlabUsernames: string[]  // GitLab @usernames that map to this agent
  keywords: string[]         // keywords in comments that trigger this agent (e.g. "coder", "devops")
  token?: string             // per-agent GitLab PAT — posts comments as this agent's user
}

export interface GitLabChannelConfig {
  webhookPort: number
  webhookSecret?: string
  host: string
  token: string
  routes: GitLabRoute[]
  agentMappings?: GitLabAgentMapping[]  // @mention -> agent mappings
}

interface GitLabNoteEvent {
  object_kind: "note"
  event_type: string
  user: { name: string; username: string }
  project: { path_with_namespace: string; web_url: string }
  object_attributes: {
    id: number
    note: string
    noteable_type: string  // "Issue", "MergeRequest", "Commit"
    url: string
  }
  issue?: { iid: number; title: string; state: string }
  merge_request?: { iid: number; title: string; state: string; source_branch: string; target_branch: string }
}

interface GitLabIssueEvent {
  object_kind: "issue"
  user: { name: string; username: string }
  project: { path_with_namespace: string }
  object_attributes: {
    iid: number
    title: string
    description: string
    state: string
    action: string
    url: string
    assignee_ids?: number[]
  }
}

interface GitLabMREvent {
  object_kind: "merge_request"
  user: { name: string; username: string }
  project: { path_with_namespace: string }
  object_attributes: {
    iid: number
    title: string
    description: string
    state: string
    action: string
    source_branch: string
    target_branch: string
    url: string
  }
}

interface GitLabPipelineEvent {
  object_kind: "pipeline"
  user: { name: string; username: string }
  project: { path_with_namespace: string }
  object_attributes: {
    id: number
    ref: string
    status: string
    duration: number
  }
}

type GitLabEvent = GitLabNoteEvent | GitLabIssueEvent | GitLabMREvent | GitLabPipelineEvent | Record<string, unknown>

export class GitLabAdapter implements ChannelAdapter {
  readonly name = "gitlab"
  private config: GitLabChannelConfig
  private handler?: (msg: IncomingMessage) => Promise<void>
  private server?: ReturnType<typeof createServer>
  private botUsername?: string  // resolved on first API call
  private botUsernames: Set<string> = new Set()  // all known bot users (to prevent cascading)
  private sentNoteIds: Set<string> = new Set()  // track our own comments
  private log: (...args: unknown[]) => void

  constructor(config: GitLabChannelConfig, log: (...args: unknown[]) => void = console.error.bind(console, "[gitlab]")) {
    this.config = config
    this.log = log
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    // Resolve bot usernames from ALL tokens (global + per-agent)
    // This is critical for cascade prevention — we must know every username
    // that posts on behalf of an agent.
    const tokensToResolve: Array<{ label: string; token: string }> = []

    if (this.config.token) {
      tokensToResolve.push({ label: "global", token: this.config.token })
    }
    for (const mapping of this.config.agentMappings || []) {
      if (mapping.token) {
        tokensToResolve.push({ label: mapping.agentId, token: mapping.token })
      }
    }

    // Resolve usernames from all tokens in parallel
    const resolutions = await Promise.allSettled(
      tokensToResolve.map(async ({ label, token }) => {
        const res = await fetch(`${this.config.host}/api/v4/user`, {
          headers: { "PRIVATE-TOKEN": token },
        })
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json() as any
        return { label, username: data.username as string }
      })
    )

    for (const result of resolutions) {
      if (result.status === "fulfilled") {
        const { label, username } = result.value
        this.botUsernames.add(username)
        if (label === "global") {
          this.botUsername = username
          this.log(`Global bot user: ${username}`)
        } else {
          this.log(`Agent "${label}" GitLab user: ${username}`)
        }
      }
    }

    // Also register all configured GitLab usernames from agentMappings
    // (in case token resolution failed or username differs from config)
    for (const mapping of this.config.agentMappings || []) {
      for (const username of mapping.gitlabUsernames) {
        this.botUsernames.add(username)
      }
    }

    this.log(`Bot users (${this.botUsernames.size}): ${[...this.botUsernames].join(", ")}`)

    this.server = createServer(async (req, res) => {
      if (req.method === "POST") {
        await this.handleWebhook(req, res)
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end("GitLab webhook endpoint. POST events here.")
      }
    })

    this.server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        this.log(`GitLab webhook port ${this.config.webhookPort} in use, retrying in 5s...`)
        setTimeout(() => {
          this.server?.close()
          this.server?.listen(this.config.webhookPort)
        }, 5000)
      } else {
        this.log(`GitLab webhook server error: ${err.message}`)
      }
    })

    this.server.listen(this.config.webhookPort, () => {
      this.log(`GitLab webhook listening on :${this.config.webhookPort}`)
    })
  }

  async stop(): Promise<void> {
    if (this.server) this.server.close()
  }

  /**
   * Send a reply — posts a comment back to GitLab via API.
   * chatId format: "project:noteable_type:iid" (e.g. "org/project:issue:123")
   */
  async send(msg: OutgoingMessage): Promise<string> {
    // chatId format: "group/project:type:iid" — split from the end
    const parts = msg.chatId.split(":")
    if (parts.length < 3) {
      this.log(`Invalid chatId for GitLab reply: ${msg.chatId}`)
      return ""
    }
    const iid = parts.pop()!
    const noteableType = parts.pop()!
    const project = parts.join(":") // rejoin in case project path had colons

    const encodedProject = encodeURIComponent(project)
    let endpoint: string

    switch (noteableType) {
      case "issue":
        endpoint = `${this.config.host}/api/v4/projects/${encodedProject}/issues/${iid}/notes`
        break
      case "merge_request":
        endpoint = `${this.config.host}/api/v4/projects/${encodedProject}/merge_requests/${iid}/notes`
        break
      default:
        this.log(`Unsupported noteable type: ${noteableType}`)
        return ""
    }

    // Use per-agent token if available, otherwise fall back to global token
    const token = this.getAgentToken(msg.agentId) || this.config.token

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": token,
        },
        // Append hidden signature so we can detect our own comments on webhook
        body: JSON.stringify({ body: `${msg.text}\n\n<!-- agentx:${msg.agentId || "unknown"} -->` }),
      })

      if (!res.ok) {
        const text = await res.text()
        this.log(`GitLab API error: ${res.status} ${text}`)
        return ""
      }

      const data = await res.json() as any
      const noteId = String(data.id || "")
      if (noteId) this.sentNoteIds.add(noteId)
      return noteId
    } catch (e: any) {
      this.log(`GitLab send error: ${e.message}`)
      return ""
    }
  }

  // --- Webhook handling ---

  private async handleWebhook(req: HttpRequest, res: ServerResponse): Promise<void> {
    // Validate secret
    if (this.config.webhookSecret) {
      const token = req.headers["x-gitlab-token"]
      if (token !== this.config.webhookSecret) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Invalid token" }))
        return
      }
    }

    const body = await this.readBody(req)
    const event = body as GitLabEvent
    const objectKind = (event.object_kind || event.event_type || "unknown") as string

    this.log(`Event: ${objectKind} from ${(event as any).project?.path_with_namespace || "unknown"}`)

    // Route based on event type
    switch (objectKind) {
      case "note":
        await this.handleNote(event as GitLabNoteEvent, res)
        break
      case "issue":
        await this.handleIssue(event as GitLabIssueEvent, res)
        break
      case "merge_request":
        await this.handleMR(event as GitLabMREvent, res)
        break
      case "pipeline":
        await this.handlePipeline(event as GitLabPipelineEvent, res)
        break
      default:
        this.log(`Unhandled event: ${objectKind}`)
        res.writeHead(200)
        res.end("ok")
    }
  }

  /**
   * Handle note/comment events — the primary use case.
   * Routes @mention comments to the right agent.
   */
  private async handleNote(event: GitLabNoteEvent, res: ServerResponse): Promise<void> {
    if (!this.handler) { res.writeHead(200); res.end("ok"); return }

    const note = event.object_attributes.note
    const project = event.project.path_with_namespace
    const user = event.user
    const noteId = String(event.object_attributes.id)

    // PRIMARY CASCADE PREVENTION: Check for AgentX signature.
    // Every comment posted by AgentX has <!-- agentx:AGENT_ID --> appended.
    // This is the most reliable check — immune to race conditions and
    // username misconfiguration.
    const signatureMatch = note.match(/<!-- agentx:(\S+) -->/)
    if (signatureMatch) {
      const sourceAgent = signatureMatch[1]
      // Allow bot-to-bot handoff: if an agent's comment @mentions a DIFFERENT agent
      const mentions = note.match(/@(\w[\w.-]*)/g)?.map(m => m.slice(1)) || []
      const mentionsDifferentAgent = mentions.some(m => {
        const mapping = this.config.agentMappings?.find(am =>
          am.gitlabUsernames.some(u => u.toLowerCase() === m.toLowerCase())
        )
        return mapping && mapping.agentId !== sourceAgent
      })
      if (!mentionsDifferentAgent) {
        this.log(`AgentX comment from ${sourceAgent}, no cross-agent mention, skipping (note ${noteId})`)
        res.writeHead(200); res.end("ok"); return
      }
      this.log(`Bot-to-bot handoff: ${sourceAgent} → ${mentions.join(", ")} (note ${noteId})`)
    }

    // SECONDARY: Also check sentNoteIds (catches race with signature)
    if (this.sentNoteIds.has(noteId)) {
      this.sentNoteIds.delete(noteId)
      res.writeHead(200); res.end("ok"); return
    }

    // TERTIARY: Skip comments from known bot users that have no @mentions
    // (catches comments posted via CLI tools without the signature)
    const mentions = note.match(/@(\w[\w.-]*)/g)?.map(m => m.slice(1)) || []
    if (mentions.length === 0) {
      this.log(`No @mention in note ${noteId}, skipping`)
      res.writeHead(200); res.end("ok"); return
    }

    if (this.isBotUser(user.username) && !signatureMatch) {
      this.log(`Bot comment from ${user.username} without signature, skipping (note ${noteId})`)
      res.writeHead(200); res.end("ok"); return
    }

    // Determine the noteable context
    let noteableType = ""
    let noteableIid = ""
    let noteableTitle = ""
    if (event.issue) {
      noteableType = "issue"
      noteableIid = String(event.issue.iid)
      noteableTitle = event.issue.title
    } else if (event.merge_request) {
      noteableType = "merge_request"
      noteableIid = String(event.merge_request.iid)
      noteableTitle = event.merge_request.title
    }

    // Resolve agent deterministically from GitLab @mention -> agentMappings
    const resolvedAgentId = this.resolveAgentFromMention(note)
    if (!resolvedAgentId) {
      // No agent matched the @mention — try project route fallback
      const fallbackAgent = this.resolveAgent(project)
      if (!fallbackAgent) {
        this.log(`No agent matched @mentions in note ${noteId}, skipping`)
        res.writeHead(200); res.end("ok"); return
      }
      this.log(`No agent mapping for @mentions, falling back to project route: ${fallbackAgent}`)
    }

    const targetAgentId = resolvedAgentId || this.resolveAgent(project)

    // React with 👀 using the RESOLVED agent's own token (deterministic identity)
    const agentMapping = this.config.agentMappings?.find(m => m.agentId === targetAgentId)
    const agentToken = agentMapping?.token
    this.reactToNote(project, noteableType, noteableIid, event.object_attributes.id, agentToken).catch(() => {})

    const chatId = `${project}:${noteableType}:${noteableIid}`

    const channelMeta = await this.getChannelMeta(chatId)

    const incoming: IncomingMessage = {
      id: String(event.object_attributes.id),
      channel: "gitlab",
      accountId: "default",
      sender: {
        id: chatId,
        name: user.name,
        username: user.username,
      },
      text: `[GitLab ${noteableType} #${noteableIid}: ${noteableTitle}]\n${user.name} commented:\n${note.replace(/\n*<!-- agentx:\S+ -->/g, "")}`,
      timestamp: new Date(),
      raw: event,
      // Deterministic: resolvedAgent comes from agentMappings, not registry.findByMention()
      resolvedAgent: targetAgentId,
      channelMeta: channelMeta ? { ...channelMeta, issue: { type: noteableType, iid: noteableIid, title: noteableTitle } } : undefined,
    }

    this.handler(incoming).catch((e) => {
      this.log(`Error handling note: ${e.message}`)
    })

    res.writeHead(200)
    res.end("ok")
  }

  /**
   * Handle issue events (opened, updated, closed).
   * Only routes events from human users, not bot-triggered updates.
   */
  private async handleIssue(event: GitLabIssueEvent, res: ServerResponse): Promise<void> {
    if (!this.handler) { res.writeHead(200); res.end("ok"); return }

    // Skip bot-triggered issue updates (label changes, assignments by agents)
    if (this.isBotUser(event.user.username)) {
      res.writeHead(200); res.end("ok"); return
    }

    const attrs = event.object_attributes
    const project = event.project.path_with_namespace
    const agentId = this.resolveAgent(project)

    const incoming: IncomingMessage = {
      id: `issue-${attrs.iid}-${attrs.action}`,
      channel: "gitlab",
      accountId: "default",
      sender: {
        id: `${project}:issue:${attrs.iid}`,
        name: event.user.name,
        username: event.user.username,
      },
      // No group — sender.id has project:type:iid for reply routing
      text: `[GitLab Issue #${attrs.iid} ${attrs.action}]: ${attrs.title}\n${attrs.description?.slice(0, 500) || ""}\nURL: ${attrs.url}`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: agentId,
    }

    this.handler(incoming).catch((e) => this.log(`Error handling issue: ${e.message}`))
    res.writeHead(200)
    res.end("ok")
  }

  /**
   * Handle merge request events.
   */
  private async handleMR(event: GitLabMREvent, res: ServerResponse): Promise<void> {
    if (!this.handler) { res.writeHead(200); res.end("ok"); return }

    // Skip bot-triggered MR updates
    if (this.isBotUser(event.user.username)) {
      res.writeHead(200); res.end("ok"); return
    }

    const attrs = event.object_attributes
    const project = event.project.path_with_namespace
    const agentId = this.resolveAgent(project)

    const incoming: IncomingMessage = {
      id: `mr-${attrs.iid}-${attrs.action}`,
      channel: "gitlab",
      accountId: "default",
      sender: {
        id: `${project}:merge_request:${attrs.iid}`,
        name: event.user.name,
        username: event.user.username,
      },
      // No group — sender.id has project:type:iid for reply routing
      text: `[GitLab MR !${attrs.iid} ${attrs.action}]: ${attrs.title}\nBranch: ${attrs.source_branch} -> ${attrs.target_branch}\n${attrs.description?.slice(0, 500) || ""}\nURL: ${attrs.url}`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: agentId,
    }

    this.handler(incoming).catch((e) => this.log(`Error handling MR: ${e.message}`))
    res.writeHead(200)
    res.end("ok")
  }

  /**
   * Handle pipeline events (success, failed).
   */
  private async handlePipeline(event: GitLabPipelineEvent, res: ServerResponse): Promise<void> {
    if (!this.handler) { res.writeHead(200); res.end("ok"); return }

    // Only notify on failures
    if (event.object_attributes.status !== "failed") {
      res.writeHead(200)
      res.end("ok")
      return
    }

    const attrs = event.object_attributes
    const project = event.project.path_with_namespace
    const agentId = this.resolveAgent(project)

    const incoming: IncomingMessage = {
      id: `pipeline-${attrs.id}`,
      channel: "gitlab",
      accountId: "default",
      sender: {
        id: `${project}:pipeline:${attrs.id}`,
        name: event.user.name,
        username: event.user.username,
      },
      // No group — sender.id has project:type:iid for reply routing
      text: `[GitLab Pipeline FAILED] Project: ${project}\nRef: ${attrs.ref}\nDuration: ${attrs.duration}s\nPlease investigate the failure.`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: agentId,
    }

    this.handler(incoming).catch((e) => this.log(`Error handling pipeline: ${e.message}`))
    res.writeHead(200)
    res.end("ok")
  }

  /**
   * Resolve agent from @mentions in a comment.
   * Only checks agentMappings for explicit GitLab @username mentions.
   * Keywords are NOT checked — they cause false positives when normal
   * issue text contains words like "deploy", "test", "coder".
   */
  private resolveAgentFromMention(text: string): string | undefined {
    if (!this.config.agentMappings?.length) return undefined

    // Extract @mentions from the comment
    const mentions = text.match(/@(\w[\w.-]*)/g)?.map(m => m.slice(1).toLowerCase()) || []
    if (mentions.length === 0) return undefined

    for (const mapping of this.config.agentMappings) {
      // Check if any GitLab @username matches
      for (const username of mapping.gitlabUsernames) {
        if (mentions.includes(username.toLowerCase())) {
          this.log(`Mention @${username} -> agent ${mapping.agentId}`)
          return mapping.agentId
        }
      }
    }

    return undefined
  }

  /**
   * Resolve which agent handles a project based on routes.
   */
  private resolveAgent(project: string): string | undefined {
    for (const route of this.config.routes) {
      if (route.project === project || route.project === "*") {
        return route.agent
      }
    }
    return undefined
  }

  /**
   * Get verified context for a GitLab project chat.
   * chatId format: "project/path:issue:123" or "project/path:merge_request:456"
   */
  async getChannelMeta(chatId: string): Promise<ChannelMeta | undefined> {
    const parts = chatId.split(":")
    const project = parts[0]
    const noteableType = parts[1]
    const noteableIid = parts[2]

    // Find all agents mapped to this project
    const agents: ChannelMeta["agents"] = []
    for (const route of this.config.routes) {
      if (route.project === project || route.project === "*") {
        agents.push({ id: route.agent, name: route.agent })
      }
    }
    for (const mapping of this.config.agentMappings || []) {
      if (!agents.some(a => a.id === mapping.agentId)) {
        agents.push({ id: mapping.agentId, name: mapping.agentId })
      }
    }

    const facts: string[] = [
      "This is a GitLab webhook event — respond as a GitLab comment",
      "Do NOT use Telegram handles or delegate to other agents",
      "Do NOT mention other agents by name — you are the only agent responding to this event",
      "Stay in your role — do not act as or speak for other agents",
    ]

    return {
      channel: "gitlab",
      agents,
      project,
      issue: noteableType && noteableIid ? { type: noteableType, iid: noteableIid, title: "" } : undefined,
      facts,
    }
  }

  /**
   * Check if a username belongs to a known bot/agent user.
   */
  private isBotUser(username: string): boolean {
    return this.botUsernames.has(username)
  }

  /**
   * Get the per-agent GitLab token from agentMappings.
   * Falls back to undefined if no per-agent token is configured.
   */
  getAgentToken(agentId?: string): string | undefined {
    if (!agentId || !this.config.agentMappings?.length) return undefined
    const mapping = this.config.agentMappings.find(m => m.agentId === agentId)
    return mapping?.token
  }

  /**
   * Find the per-agent token for the first @mentioned agent in note text.
   */
  private getTokenForMentionedAgent(text: string): string | undefined {
    if (!this.config.agentMappings?.length) return undefined
    const mentionedUsers = text.match(/@(\w[\w.-]*)/g)?.map(m => m.slice(1).toLowerCase()) || []
    for (const mapping of this.config.agentMappings) {
      if (mapping.token && mapping.gitlabUsernames.some(u => mentionedUsers.includes(u.toLowerCase()))) {
        return mapping.token
      }
    }
    return undefined
  }

  /**
   * React to a GitLab note with an emoji (👀 eyes) to acknowledge receipt.
   * Uses the agent's own token when available.
   */
  private async reactToNote(project: string, noteableType: string, noteableIid: string, noteId: number, agentToken?: string): Promise<void> {
    const encodedProject = encodeURIComponent(project)
    let endpoint: string

    switch (noteableType) {
      case "issue":
        endpoint = `${this.config.host}/api/v4/projects/${encodedProject}/issues/${noteableIid}/notes/${noteId}/award_emoji`
        break
      case "merge_request":
        endpoint = `${this.config.host}/api/v4/projects/${encodedProject}/merge_requests/${noteableIid}/notes/${noteId}/award_emoji`
        break
      default:
        return
    }

    try {
      await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": agentToken || this.config.token,
        },
        body: JSON.stringify({ name: "eyes" }),
      })
    } catch (e: any) {
      this.log(`Failed to react to note ${noteId}: ${e.message}`)
    }
  }

  private async readBody(req: HttpRequest): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let body = ""
      req.on("data", (chunk: Buffer) => (body += chunk.toString()))
      req.on("end", () => {
        try { resolve(body ? JSON.parse(body) : {}) }
        catch { resolve({ raw: body }) }
      })
      req.on("error", () => resolve({}))
    })
  }
}
