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
    // Resolve bot username to skip own comments
    try {
      const res = await fetch(`${this.config.host}/api/v4/user`, {
        headers: { "PRIVATE-TOKEN": this.config.token },
      })
      const data = await res.json() as any
      this.botUsername = data.username
      this.log(`Bot user: ${this.botUsername}`)
    } catch (e: any) {
      this.log(`Could not resolve bot user: ${e.message}`)
    }

    this.server = createServer(async (req, res) => {
      if (req.method === "POST") {
        await this.handleWebhook(req, res)
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end("GitLab webhook endpoint. POST events here.")
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

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": this.config.token,
        },
        body: JSON.stringify({ body: msg.text }),
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

    // Skip our own comments (prevents infinite loop).
    // All agents share the same GitLab API token/user, so any agent's reply
    // will come from this.botUsername — skip ALL of them.
    if (this.botUsername && user.username === this.botUsername) {
      this.log(`Skipping own comment from ${this.botUsername} (note ${noteId})`)
      res.writeHead(200); res.end("ok"); return
    }

    // Skip comments we already sent (belt-and-suspenders with above check)
    if (this.sentNoteIds.has(noteId)) {
      this.sentNoteIds.delete(noteId)
      res.writeHead(200); res.end("ok"); return
    }

    // Additional loop protection: skip if comment was recently posted by any agent.
    // sentNoteIds tracks IDs from send(), but webhook may arrive before send() returns.
    // Use a time-based window: ignore notes from bot user within last 30s.
    // (Already handled by botUsername check above, but keeping for clarity)

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

    // Resolve agent: project route is the fallback. @mention resolution is
    // handled by the router via registry.findByMention() — which uses the
    // agent's `mentions` array (single source of truth for all channels).
    const projectAgent = this.resolveAgent(project)

    // React with 👀 to acknowledge we've seen the comment
    this.reactToNote(project, noteableType, noteableIid, event.object_attributes.id).catch(() => {})

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
      text: `[GitLab ${noteableType} #${noteableIid}: ${noteableTitle}]\n${user.name} commented:\n${note}`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: projectAgent,  // fallback only — router tries mention matching first
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
   */
  private async handleIssue(event: GitLabIssueEvent, res: ServerResponse): Promise<void> {
    if (!this.handler) { res.writeHead(200); res.end("ok"); return }

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
   * React to a GitLab note with an emoji (👀 eyes) to acknowledge receipt.
   */
  private async reactToNote(project: string, noteableType: string, noteableIid: string, noteId: number): Promise<void> {
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
          "PRIVATE-TOKEN": this.config.token,
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
