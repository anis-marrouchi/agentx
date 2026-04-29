import type { ChannelAdapter, IncomingMessage, OutgoingMessage, ChannelMeta, SeededMessage } from "./types"
import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from "http"
import { debug } from "@/observability/debug"
import type { HookRegistry } from "@/hooks"
import { markBody, detectAgentxMarker, stripAgentxMarkers } from "./outbound-marker"
import { getLedgerMode } from "@/intent/mode"
import { getDefaultLedger } from "@/intent/instance"
import { recordGitLabTargetDispatch } from "@/intent/sources/gitlab"

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
  node?: string              // if set, forward to this mesh peer instead of handling locally
}

export interface GitLabChannelConfig {
  webhookPort: number
  webhookSecret?: string
  host: string
  token: string
  routes: GitLabRoute[]
  agentMappings?: GitLabAgentMapping[]  // @mention -> agent mappings
  /** All known agent ids in this daemon — passed from the outer config by
   *  the daemon at construction time. Used to auto-derive default GitLab
   *  username mappings so operators don't have to hand-register every agent
   *  for @mentions to work. Explicit entries in `agentMappings` always take
   *  precedence (they carry per-agent tokens, non-standard usernames, etc.)
   *  The auto-derived defaults use the convention `{agentId, noqta-<agentId>}`
   *  which mirrors the existing hand-maintained rows (pm-mtgl, atlas, ...).
   *
   *  Removal: when an agent is deleted from agents.<id>, its default mapping
   *  disappears on next daemon restart. */
  knownAgentIds?: string[]
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
  /** Top-level current assignees (GitLab webhook payload). Each carries
   *  username + name + id. Present on create, update, and reopen. Optional
   *  in the type because some older payloads only carry assignee_ids. */
  assignees?: Array<{ id: number; name?: string; username: string }>
  /** Diff payload — present on `update` actions. We use changes.assignees
   *  to detect assignment-add events (a username appears in current but
   *  not previous). */
  changes?: {
    assignees?: { previous?: Array<{ id: number; username: string }>; current?: Array<{ id: number; username: string }> }
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
    assignee_ids?: number[]
    reviewer_ids?: number[]
  }
  assignees?: Array<{ id: number; name?: string; username: string }>
  reviewers?: Array<{ id: number; name?: string; username: string }>
  changes?: {
    assignees?: { previous?: Array<{ id: number; username: string }>; current?: Array<{ id: number; username: string }> }
    reviewers?: { previous?: Array<{ id: number; username: string }>; current?: Array<{ id: number; username: string }> }
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
  /** Maps actual GitLab username -> agentId (resolved from tokens at startup) */
  private usernameToAgent: Map<string, string> = new Map()
  /** Maps agentId -> actual GitLab username (resolved from tokens at startup) */
  private agentToUsername: Map<string, string> = new Map()
  /** Per-event dedup window for handleIssue/handleMR. Key:
   *  `{project}:{kind}:{iid}:{agentId}:{action}:{trigger}`. Value:
   *  expiresAtMs. Pruned lazily on each access. 5-min TTL covers GitLab's
   *  webhook-retry window without keeping stale entries forever. */
  private dispatchedTargets: Map<string, number> = new Map()
  private readonly DISPATCH_TTL_MS = 5 * 60 * 1000
  private log: (...args: unknown[]) => void
  private hooks?: HookRegistry
  private reactForwarder?: (node: string, project: string, noteableType: string, noteableIid: string, noteId: number, agentId: string) => Promise<void>
  private sendNoteForwarder?: (node: string, project: string, noteableType: string, noteableIid: string, agentId: string, text: string) => Promise<string>
  private logTimeForwarder?: (node: string, project: string, noteableType: string, noteableIid: string, agentId: string, durationMs: number) => Promise<void>
  private createIssueForwarder?: (node: string, project: string, title: string, description: string, labels: string[], assignees: string[], agentId: string) => Promise<{ iid: number; url: string } | null>
  private setLabelsForwarder?: (node: string, project: string, kind: "issue" | "merge_request", iid: string, add: string[], remove: string[], agentId: string) => Promise<string[] | null>

  constructor(config: GitLabChannelConfig, log: (...args: unknown[]) => void = console.error.bind(console, "[gitlab]"), hooks?: HookRegistry) {
    this.config = config
    this.log = log
    this.hooks = hooks
  }

  setReactForwarder(fn: (node: string, project: string, noteableType: string, noteableIid: string, noteId: number, agentId: string) => Promise<void>): void {
    this.reactForwarder = fn
  }

  setSendNoteForwarder(fn: (node: string, project: string, noteableType: string, noteableIid: string, agentId: string, text: string) => Promise<string>): void {
    this.sendNoteForwarder = fn
  }

  setLogTimeForwarder(fn: (node: string, project: string, noteableType: string, noteableIid: string, agentId: string, durationMs: number) => Promise<void>): void {
    this.logTimeForwarder = fn
  }

  setCreateIssueForwarder(fn: (node: string, project: string, title: string, description: string, labels: string[], assignees: string[], agentId: string) => Promise<{ iid: number; url: string } | null>): void {
    this.createIssueForwarder = fn
  }

  setSetLabelsForwarder(fn: (node: string, project: string, kind: "issue" | "merge_request", iid: string, add: string[], remove: string[], agentId: string) => Promise<string[] | null>): void {
    this.setLabelsForwarder = fn
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
          // Map actual username <-> agentId (authoritative — from API, not config)
          this.usernameToAgent.set(username.toLowerCase(), label)
          this.agentToUsername.set(label, username.toLowerCase())
          this.log(`Agent "${label}" -> GitLab user @${username}`)
        }
      }
    }

    // Also register configured gitlabUsernames for cascade prevention
    // AND as fallback mention matching (if token resolution failed)
    for (const mapping of this.config.agentMappings || []) {
      for (const username of mapping.gitlabUsernames) {
        this.botUsernames.add(username)
        // Remote-routed mappings (node property) take explicit priority over token resolution.
        // Token resolution is authoritative only for local agents.
        const alreadySet = this.usernameToAgent.has(username.toLowerCase())
        if (!alreadySet || mapping.node) {
          this.usernameToAgent.set(username.toLowerCase(), mapping.agentId)
        }
      }
      // Fallback: if token resolution didn't set agentToUsername, use first configured username
      if (!this.agentToUsername.has(mapping.agentId) && mapping.gitlabUsernames.length > 0) {
        this.agentToUsername.set(mapping.agentId, mapping.gitlabUsernames[0].toLowerCase())
      }
    }

    // Auto-derived defaults: every agent in the daemon that doesn't have an
    // explicit `agentMappings` row gets a default entry so @-mentions route
    // without operators hand-maintaining a parallel list.
    //
    // Convention: `@<agentId>` and `@noqta-<agentId>` both route to the
    // agent — mirrors existing hand-maintained rows (pm-mtgl → [pm-mtgl,
    // noqta-pm-mtgl], atlas → [atlas, noqta-atlas], ...). Author explicit
    // entries in agentMappings when an agent needs a per-agent token or a
    // non-standard username.
    const explicitAgentIds = new Set((this.config.agentMappings ?? []).map((m) => m.agentId))
    const autoMapped: string[] = []
    for (const agentId of this.config.knownAgentIds ?? []) {
      if (explicitAgentIds.has(agentId)) continue
      // Skip internal/utility ids that aren't actual agents in the GitLab
      // sense (e.g. "graph-agent" only ever talks on the a2a mesh).
      const defaultUsernames = [agentId, `noqta-${agentId}`]
      for (const username of defaultUsernames) {
        this.botUsernames.add(username)
        if (!this.usernameToAgent.has(username.toLowerCase())) {
          this.usernameToAgent.set(username.toLowerCase(), agentId)
        }
      }
      if (!this.agentToUsername.has(agentId)) {
        this.agentToUsername.set(agentId, agentId.toLowerCase())
      }
      autoMapped.push(agentId)
    }

    this.log(`Bot users (${this.botUsernames.size}): ${[...this.botUsernames].join(", ")}`)
    this.log(`Username->Agent map: ${[...this.usernameToAgent.entries()].map(([u, a]) => `@${u}->${a}`).join(", ")}`)
    if (autoMapped.length > 0) {
      this.log(`GitLab auto-derived defaults for ${autoMapped.length} agent(s): ${autoMapped.join(", ")} (override by adding an agentMappings entry)`)
    }

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

    // Identity rules — posts must go out under the agent's own GitLab user,
    // never under the shared group-access-token user (e.g. @group_<id>_bot_*):
    //
    //   1. If the agent has a per-agent token configured locally → use it.
    //   2. Else if the agent lives on a remote peer (mapping.node) and a
    //      sendNoteForwarder is wired → forward the post there. The peer uses
    //      its own local token (owned by that agent's GitLab user) to POST.
    //   3. Else fall back to the global token (signed content from a generic
    //      shared identity — legacy path, only reached for local agents with
    //      no token mapping).
    const mapping = this.config.agentMappings?.find((m) => m.agentId === msg.agentId)
    const agentToken = this.getAgentToken(msg.agentId)
    if (!agentToken && mapping?.node && this.sendNoteForwarder) {
      try {
        const body = markBody(msg.text, msg.agentId || "unknown")
        const noteId = await this.sendNoteForwarder(mapping.node, project, noteableType, iid, msg.agentId || "", body)
        if (noteId) this.sentNoteIds.add(noteId)
        return noteId
      } catch (e: any) {
        this.log(`GitLab send forward to "${mapping.node}" failed: ${e.message} — skipping (would post as group bot)`)
        return ""
      }
    }

    const token = agentToken || this.config.token
    debug.webhook("gitlab", "send", `agentId="${msg.agentId}" token=${agentToken ? "per-agent" : "GLOBAL(" + this.botUsername + ")"}`)

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": token,
        },
        // Append hidden signature so we can detect our own comments on webhook
        body: JSON.stringify({ body: markBody(msg.text, msg.agentId || "unknown") }),
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
    const objectKind = ((event as any).object_kind || (event as any).event_type || "unknown") as string

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
    const sourceAgent = detectAgentxMarker(note)
    if (sourceAgent) {
      // Allow bot-to-bot handoff: if an agent's comment @mentions a DIFFERENT agent
      const mentions = note.match(/@(\w[\w.-]*)/g)?.map(m => m.slice(1).replace(/[.]+$/, "")) || []
      const mentionsDifferentAgent = mentions.some(m => {
        const targetAgent = this.usernameToAgent.get(m.toLowerCase())
        return targetAgent && targetAgent !== sourceAgent
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
    const mentions = note.match(/@(\w[\w.-]*)/g)?.map(m => m.slice(1).replace(/[.]+$/, "")) || []
    if (mentions.length === 0) {
      this.log(`No @mention in note ${noteId}, skipping`)
      res.writeHead(200); res.end("ok"); return
    }

    if (this.isBotUser(user.username) && !sourceAgent) {
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

    // Resolve agent deterministically from GitLab @mention -> usernameToAgent map.
    debug.webhook("gitlab", "handleNote", `noteId=${noteId} mentions=[${mentions.join(",")}] user=${user.username}`)

    const resolvedAgentId = this.resolveAgentFromMention(note)
    debug.webhook("gitlab", "resolve", `agentId=${resolvedAgentId ?? "NONE"}`)

    if (!resolvedAgentId) {
      this.log(`[handleNote] @mentions in note ${noteId} are not agents (${mentions.join(", ")}), skipping`)
      res.writeHead(200); res.end("ok"); return
    }

    const targetAgentId = resolvedAgentId

    // React with 👀 using the RESOLVED agent's own token (deterministic identity)
    const agentMapping = this.config.agentMappings?.find(m => m.agentId === targetAgentId)
    const agentToken = agentMapping?.token
    const agentNode = (agentMapping as any)?.node as string | undefined
    debug.webhook("gitlab", "token", `agent="${targetAgentId}" mapping=${agentMapping ? "found" : "MISSING"} hasToken=${!!agentToken} node=${agentNode ?? "local"}`)
    this.reactToNote(project, noteableType, noteableIid, event.object_attributes.id, agentToken, agentNode, targetAgentId).catch(() => {})

    const chatId = `${project}:${noteableType}:${noteableIid}`

    const channelMeta = await this.getChannelMeta(chatId)

    // Download any images attached in the comment
    const noteClean = stripAgentxMarkers(note)
    const imageAttachment = await this.downloadNoteImages(noteClean, project, agentToken || this.config.token)

    const incoming: IncomingMessage = {
      id: String(event.object_attributes.id),
      channel: "gitlab",
      accountId: "default",
      sender: {
        id: chatId,
        name: user.name,
        username: user.username,
      },
      text: `[GitLab ${project} ${noteableType} #${noteableIid}: ${noteableTitle}]\n${user.name} commented:\n${noteClean}`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: targetAgentId,
      preferNode: agentMapping?.node,
      channelMeta: channelMeta ? { ...channelMeta, issue: { type: noteableType, iid: noteableIid, title: noteableTitle } } : undefined,
      media: imageAttachment,
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

    const attrs = event.object_attributes
    const project = event.project.path_with_namespace
    const defaultAgentId = this.resolveAgent(project)

    // Bot-authored issue events (label changes, assignments by agents) skip
    // the DEFAULT agent dispatch path to prevent cascade loops — but still
    // fire the `on:gitlab-issue` hook below so workflow subscribers and
    // custom hook handlers can opt in to them. This matters for BPM-style
    // workflows (gitlab-sdlc-loop, etc.) that want to react to every label
    // transition, including bot-driven ones.
    const authoredByBot = this.isBotUser(event.user.username)
    if (authoredByBot) {
      this.log(`Issue #${attrs.iid} authored by bot "${event.user.username}" — default dispatch suppressed (hooks still fire)`)
    }

    // Fire `on:gitlab-issue` hook so projects can customize routing — e.g.
    // trigger a specific agent on assignment rather than the project default.
    // The hook may:
    //   - return `blocked: true` to suppress the default dispatch
    //   - return `modified.dispatch: Array<{ agentId, preferNode?, prompt? }>`
    //     to dispatch to one or more specific agents (skips default)
    //   - return nothing, letting the default project-agent behavior run
    // The event body stays inside the context so hook scripts have full detail
    // (changes.assignees, attrs.assignees, labels, etc.) without us re-parsing.
    let dispatch: Array<{ agentId: string; preferNode?: string; prompt?: string; assignee?: string }> | undefined
    let hookBlocked = false
    if (this.hooks?.has("on:gitlab-issue" as any)) {
      try {
        const result = await this.hooks.execute("on:gitlab-issue" as any, {
          event: "on:gitlab-issue" as any,
          issueEvent: event,
          project,
          iid: attrs.iid,
          title: attrs.title,
          description: attrs.description || "",
          url: attrs.url,
          action: attrs.action,
          usernameToAgent: Object.fromEntries(this.usernameToAgent.entries()),
          agentMappings: this.config.agentMappings || [],
          defaultAgentId: defaultAgentId || null,
        })
        if (result.blocked) {
          hookBlocked = true
        }
        const modDispatch = (result.modified as any)?.dispatch
        if (Array.isArray(modDispatch) && modDispatch.length > 0) {
          dispatch = modDispatch.filter((d: any) => d && typeof d.agentId === "string")
        }
      } catch (e: any) {
        this.log(`on:gitlab-issue hook error: ${e.message}`)
      }
    }

    // Hook-driven dispatch: route one IncomingMessage per dispatch entry.
    if (dispatch && dispatch.length > 0) {
      for (const d of dispatch) {
        const mapping = this.config.agentMappings?.find((m) => m.agentId === d.agentId)
        const chatId = `${project}:issue:${attrs.iid}`
        const channelMeta = await this.getChannelMeta(chatId)
        const id = `issue-hook-${attrs.iid}-${d.agentId}${d.assignee ? `-${d.assignee}` : ""}-${attrs.action}`
        const incoming: IncomingMessage = {
          id,
          channel: "gitlab",
          accountId: "default",
          sender: {
            id: chatId,
            name: event.user.name,
            username: event.user.username,
          },
          text: d.prompt || `[GitLab ${project} Issue #${attrs.iid} ${attrs.action}]: ${attrs.title}\n${attrs.description?.slice(0, 500) || ""}\nURL: ${attrs.url}`,
          timestamp: new Date(),
          raw: event,
          resolvedAgent: d.agentId,
          preferNode: d.preferNode || mapping?.node,
          channelMeta: channelMeta ? {
            ...channelMeta,
            issue: { type: "issue", iid: String(attrs.iid), title: attrs.title },
          } : undefined,
        }
        this.log(`Issue #${attrs.iid} hook dispatch -> agent "${d.agentId}"${d.preferNode || mapping?.node ? ` (remote: ${d.preferNode || mapping?.node})` : ""}`)
        this.handler(incoming).catch((e) => this.log(`Error handling hook dispatch: ${e.message}`))
      }
      res.writeHead(200); res.end("ok"); return
    }

    if (hookBlocked) {
      this.log(`Issue #${attrs.iid}: on:gitlab-issue hook suppressed default dispatch`)
      res.writeHead(200); res.end("ok"); return
    }

    // Bot-authored events: hook(s) above already ran; we stop before default
    // agent dispatch to prevent cascade loops.
    if (authoredByBot) { res.writeHead(200); res.end("ok"); return }

    // Build a deterministic target set: mentions in description ∪ current
    // assignees mapped to agents ∪ project default route. Each unique agent
    // gets exactly one IncomingMessage. Replaces the prior "default route only"
    // behavior so an issue assigned to an agent always gets that agent
    // engaged — matching how comments resolve via @mention. The
    // `on:gitlab-issue` hook above can still fully override or block.
    const targets = this.computeIssueTargets(event, defaultAgentId)
    if (targets.length === 0) {
      this.log(`Issue #${attrs.iid}: no agent target (no mention, no agent assignee, no default route)`)
      res.writeHead(200); res.end("ok"); return
    }

    // Phase 1 commit 6.a: shadow-mode ledger observes the loop. We
    // compute `wasDuplicate` up front (rather than `continue`-ing on
    // legacy dedup hits) so the ledger sees BOTH branches — fresh
    // dispatches AND legacy-deduped ones — and the divergence reporter
    // surfaces gaps between the legacy TTL dedup and the ledger's
    // active-task model. Both views live side-by-side until the 1c→1d
    // promotions retire legacy dedup.
    const ledgerEnabled = getLedgerMode("gitlab") !== "off"
    const issueProjection = ledgerEnabled
      ? {
          entityKind: "issue" as const,
          project,
          iid: attrs.iid,
          action: attrs.action,
          title: attrs.title,
          description: attrs.description,
          url: attrs.url,
        }
      : null
    const eventJson = ledgerEnabled ? JSON.stringify(event) : ""

    for (const t of targets) {
      const dedupKey = `${project}:issue:${attrs.iid}:${t.agentId}:${attrs.action}:${t.trigger}`
      const wasDuplicate = this.isDispatchedRecently(dedupKey)

      if (wasDuplicate) {
        this.log(`Issue #${attrs.iid}: skip duplicate dispatch ${dedupKey}`)
      } else {
        this.markDispatched(dedupKey)

        const mapping = this.config.agentMappings?.find((m) => m.agentId === t.agentId)
        const chatId = `${project}:issue:${attrs.iid}`
        const channelMeta = await this.getChannelMeta(chatId)

        // Assignment-trigger gets a "start working" prompt; mention/default
        // get the standard issue summary. Both end with the issue URL so the
        // agent can navigate to it.
        const text = t.trigger === "assignee-added"
          ? `[GitLab ${project} Issue #${attrs.iid} assigned to you: ${attrs.title}]\n${attrs.description?.slice(0, 1500) || ""}\nURL: ${attrs.url}\n\nPlease acknowledge this assignment in a comment, then start working on the issue.`
          : `[GitLab ${project} Issue #${attrs.iid} ${attrs.action}]: ${attrs.title}\n${attrs.description?.slice(0, 500) || ""}\nURL: ${attrs.url}`

        const incoming: IncomingMessage = {
          id: `issue-${attrs.iid}-${attrs.action}-${t.agentId}-${t.trigger}`,
          channel: "gitlab",
          accountId: "default",
          sender: {
            id: chatId,
            name: event.user.name,
            username: event.user.username,
          },
          text,
          timestamp: new Date(),
          raw: event,
          resolvedAgent: t.agentId,
          preferNode: mapping?.node,
          channelMeta: channelMeta ? {
            ...channelMeta,
            issue: { type: "issue", iid: String(attrs.iid), title: attrs.title },
          } : undefined,
        }

        this.log(`Issue #${attrs.iid} -> agent "${t.agentId}" (trigger: ${t.trigger})`)
        this.handler(incoming).catch((e) => this.log(`Error handling issue: ${e.message}`))
      }

      // Ledger observes regardless of legacy outcome. Wrapped in try/catch
      // because a ledger failure must never break the gitlab dispatch path —
      // legacy is still authoritative until the 1c per-source promotion lands.
      if (issueProjection) {
        try {
          recordGitLabTargetDispatch(
            getDefaultLedger(),
            issueProjection,
            t,
            eventJson,
            wasDuplicate
              ? { agentId: null, outcome: "deduped", reason: "isDispatchedRecently" }
              : { agentId: t.agentId, outcome: "dispatched" },
          )
        } catch (e: any) {
          this.log(`[ledger] gitlab issue #${attrs.iid} target ${t.agentId} record failed: ${e?.message ?? e}`)
        }
      }
    }

    res.writeHead(200)
    res.end("ok")
  }

  /** Compute the deterministic target set for an issue event. Order:
   *    1. agent usernames @mentioned in the description (open events)
   *    2. agent usernames newly added as assignees (changes.assignees diff)
   *    3. agent usernames in the current full assignee list (catches
   *       create-with-assignee where there are no `changes`)
   *    4. project default route (fallback only when 1-3 produced nothing)
   *  Each agent appears at most once; the first trigger that found them
   *  wins for the dedup key. */
  private computeIssueTargets(
    event: GitLabIssueEvent,
    defaultAgentId: string | undefined,
  ): Array<{ agentId: string; trigger: "mention" | "assignee-added" | "assignee-current" | "default-route" }> {
    const out: Array<{ agentId: string; trigger: "mention" | "assignee-added" | "assignee-current" | "default-route" }> = []
    const seen = new Set<string>()
    const add = (agentId: string | undefined, trigger: "mention" | "assignee-added" | "assignee-current" | "default-route") => {
      if (!agentId || seen.has(agentId)) return
      seen.add(agentId)
      out.push({ agentId, trigger })
    }

    // 1. Mentions in description
    const desc = event.object_attributes.description || ""
    const mentions = desc.match(/@(\w[\w.-]*)/g)?.map(m => m.slice(1).replace(/[.]+$/, "").toLowerCase()) || []
    for (const u of mentions) {
      add(this.usernameToAgent.get(u), "mention")
    }

    // 2. Newly added assignees (assignment trigger — the "start working" path)
    const previous = new Set((event.changes?.assignees?.previous ?? []).map(a => a.username.toLowerCase()))
    const current = (event.changes?.assignees?.current ?? []).map(a => a.username.toLowerCase())
    for (const u of current) {
      if (previous.has(u)) continue // unchanged assignment, not a fresh add
      add(this.usernameToAgent.get(u), "assignee-added")
    }

    // 3. Current full assignee list (covers create-with-assignee where
    //    `changes` is absent). Skipped when (2) already produced an agent
    //    for this event to avoid the same assignee firing twice.
    if (out.length === 0) {
      const allAssignees = (event.assignees ?? []).map(a => a.username.toLowerCase())
      for (const u of allAssignees) {
        add(this.usernameToAgent.get(u), "assignee-current")
      }
    }

    // 4. Project default route — only when nothing above resolved
    if (out.length === 0) {
      add(defaultAgentId, "default-route")
    }

    return out
  }

  /** Was this dispatch key fired within the dedup TTL window? */
  private isDispatchedRecently(key: string): boolean {
    const expires = this.dispatchedTargets.get(key)
    if (!expires) return false
    if (expires < Date.now()) {
      this.dispatchedTargets.delete(key)
      return false
    }
    return true
  }

  /** Record that we dispatched `key` and prune stale entries. */
  private markDispatched(key: string): void {
    const now = Date.now()
    this.dispatchedTargets.set(key, now + this.DISPATCH_TTL_MS)
    // Lazy prune: drop expired entries while we're touching the map.
    if (this.dispatchedTargets.size > 200) {
      for (const [k, exp] of this.dispatchedTargets) {
        if (exp < now) this.dispatchedTargets.delete(k)
      }
    }
  }

  /**
   * Handle merge request events.
   */
  private async handleMR(event: GitLabMREvent, res: ServerResponse): Promise<void> {
    if (!this.handler) { res.writeHead(200); res.end("ok"); return }

    // Skip bot-triggered MR updates (cascade prevention)
    if (this.isBotUser(event.user.username)) {
      res.writeHead(200); res.end("ok"); return
    }

    const attrs = event.object_attributes
    const project = event.project.path_with_namespace
    const defaultAgentId = this.resolveAgent(project)

    // Same target-resolution model as handleIssue: mentions ∪ assignees ∪
    // reviewers ∪ default route, deduped per-agent.
    const targets = this.computeMRTargets(event, defaultAgentId)
    if (targets.length === 0) {
      res.writeHead(200); res.end("ok"); return
    }

    // Same shadow-mode wiring as handleIssue (Phase 1 commit 6.a). Computed
    // once outside the loop; per-target ledger record happens after the
    // legacy dispatch path so the ledger sees both fresh and deduped branches.
    const ledgerEnabled = getLedgerMode("gitlab") !== "off"
    const mrProjection = ledgerEnabled
      ? {
          entityKind: "merge_request" as const,
          project,
          iid: attrs.iid,
          action: attrs.action,
          title: attrs.title,
          description: attrs.description,
          url: attrs.url,
        }
      : null
    const eventJson = ledgerEnabled ? JSON.stringify(event) : ""

    for (const t of targets) {
      const dedupKey = `${project}:merge_request:${attrs.iid}:${t.agentId}:${attrs.action}:${t.trigger}`
      const wasDuplicate = this.isDispatchedRecently(dedupKey)

      if (!wasDuplicate) {
        this.markDispatched(dedupKey)

        const mapping = this.config.agentMappings?.find((m) => m.agentId === t.agentId)
        const chatId = `${project}:merge_request:${attrs.iid}`
        const channelMeta = await this.getChannelMeta(chatId)

        const isAssignmentTrigger = t.trigger === "assignee-added" || t.trigger === "reviewer-added"
        const text = isAssignmentTrigger
          ? `[GitLab ${project} MR !${attrs.iid} ${t.trigger === "reviewer-added" ? "review requested" : "assigned to you"}: ${attrs.title}]\nBranch: ${attrs.source_branch} -> ${attrs.target_branch}\n${attrs.description?.slice(0, 1500) || ""}\nURL: ${attrs.url}\n\nPlease acknowledge in a comment, then ${t.trigger === "reviewer-added" ? "review this MR" : "start working on it"}.`
          : `[GitLab ${project} MR !${attrs.iid} ${attrs.action}]: ${attrs.title}\nBranch: ${attrs.source_branch} -> ${attrs.target_branch}\n${attrs.description?.slice(0, 500) || ""}\nURL: ${attrs.url}`

        const incoming: IncomingMessage = {
          id: `mr-${attrs.iid}-${attrs.action}-${t.agentId}-${t.trigger}`,
          channel: "gitlab",
          accountId: "default",
          sender: {
            id: chatId,
            name: event.user.name,
            username: event.user.username,
          },
          text,
          timestamp: new Date(),
          raw: event,
          resolvedAgent: t.agentId,
          preferNode: mapping?.node,
          channelMeta: channelMeta ? {
            ...channelMeta,
            issue: { type: "merge_request", iid: String(attrs.iid), title: attrs.title },
          } : undefined,
        }

        this.log(`MR !${attrs.iid} -> agent "${t.agentId}" (trigger: ${t.trigger})`)
        this.handler(incoming).catch((e) => this.log(`Error handling MR: ${e.message}`))
      }

      if (mrProjection) {
        try {
          recordGitLabTargetDispatch(
            getDefaultLedger(),
            mrProjection,
            t,
            eventJson,
            wasDuplicate
              ? { agentId: null, outcome: "deduped", reason: "isDispatchedRecently" }
              : { agentId: t.agentId, outcome: "dispatched" },
          )
        } catch (e: any) {
          this.log(`[ledger] gitlab MR !${attrs.iid} target ${t.agentId} record failed: ${e?.message ?? e}`)
        }
      }
    }

    res.writeHead(200)
    res.end("ok")
  }

  /** Compute MR targets — mirrors computeIssueTargets, with reviewer
   *  changes added as a separate trigger so an agent added as reviewer
   *  gets the "review this MR" prompt instead of "start working on it". */
  private computeMRTargets(
    event: GitLabMREvent,
    defaultAgentId: string | undefined,
  ): Array<{ agentId: string; trigger: "mention" | "assignee-added" | "assignee-current" | "reviewer-added" | "reviewer-current" | "default-route" }> {
    const out: Array<{ agentId: string; trigger: "mention" | "assignee-added" | "assignee-current" | "reviewer-added" | "reviewer-current" | "default-route" }> = []
    const seen = new Set<string>()
    const add = (
      agentId: string | undefined,
      trigger: "mention" | "assignee-added" | "assignee-current" | "reviewer-added" | "reviewer-current" | "default-route",
    ) => {
      if (!agentId || seen.has(agentId)) return
      seen.add(agentId)
      out.push({ agentId, trigger })
    }

    const desc = event.object_attributes.description || ""
    const mentions = desc.match(/@(\w[\w.-]*)/g)?.map(m => m.slice(1).replace(/[.]+$/, "").toLowerCase()) || []
    for (const u of mentions) add(this.usernameToAgent.get(u), "mention")

    const prevA = new Set((event.changes?.assignees?.previous ?? []).map(a => a.username.toLowerCase()))
    for (const a of event.changes?.assignees?.current ?? []) {
      const u = a.username.toLowerCase()
      if (prevA.has(u)) continue
      add(this.usernameToAgent.get(u), "assignee-added")
    }
    const prevR = new Set((event.changes?.reviewers?.previous ?? []).map(a => a.username.toLowerCase()))
    for (const r of event.changes?.reviewers?.current ?? []) {
      const u = r.username.toLowerCase()
      if (prevR.has(u)) continue
      add(this.usernameToAgent.get(u), "reviewer-added")
    }

    if (out.length === 0) {
      for (const a of event.assignees ?? []) add(this.usernameToAgent.get(a.username.toLowerCase()), "assignee-current")
      for (const r of event.reviewers ?? []) add(this.usernameToAgent.get(r.username.toLowerCase()), "reviewer-current")
    }

    if (out.length === 0) add(defaultAgentId, "default-route")
    return out
  }

  /**
   * Handle pipeline events (success, failed).
   */
  private async handlePipeline(event: GitLabPipelineEvent, res: ServerResponse): Promise<void> {
    const attrs = event.object_attributes
    const project = event.project.path_with_namespace
    const terminalStatuses = ["success", "failed", "canceled"]

    // Fire on:gitlab-pipeline hook for all terminal pipelines (side-effect hooks, e.g. time logging)
    if (terminalStatuses.includes(attrs.status) && this.hooks?.has("on:gitlab-pipeline" as any)) {
      this.hooks.execute("on:gitlab-pipeline" as any, {
        event: "on:gitlab-pipeline" as any,
        pipelineId: attrs.id,
        status: attrs.status,
        ref: attrs.ref,
        duration: attrs.duration,
        project,
        projectId: (event as any).project?.id,
        raw: event,
      }).catch((e: Error) => this.log(`on:gitlab-pipeline hook error: ${e.message}`))
    }

    // Only route to agent on failures
    if (!this.handler || attrs.status !== "failed") {
      res.writeHead(200)
      res.end("ok")
      return
    }

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
   * Uses the authoritative usernameToAgent map (built from API token resolution
   * at startup) — not the manually configured gitlabUsernames which may be wrong.
   */
  private resolveAgentFromMention(text: string): string | undefined {
    // Extract @mentions from the comment, strip trailing dots/punctuation
    const mentions = text.match(/@(\w[\w.-]*)/g)?.map(m => m.slice(1).replace(/[.]+$/, "").toLowerCase()) || []
    if (mentions.length === 0) return undefined

    // Check against the authoritative username->agent map (resolved from tokens)
    for (const mention of mentions) {
      const agentId = this.usernameToAgent.get(mention)
      if (agentId) {
        this.log(`Mention @${mention} -> agent "${agentId}" (resolved from token)`)
        return agentId
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

  /** ChannelAdapter.seedHistory: fetch the issue/MR's existing notes from
   *  the GitLab API and return them oldest-first so a fresh agent session
   *  starts mirroring the live thread. chatId is the canonical
   *  "project:type:iid" the rest of the adapter already uses (see send()).
   *  Filters out agentx-signed notes from the calling agent (those are this
   *  agent's own past replies — already represented in the model's prior
   *  turns). Best-effort: API errors return [] rather than throwing. */
  async seedHistory(
    chatId: string,
    opts: { sinceISO?: string; maxMessages: number; maxChars: number },
  ): Promise<SeededMessage[]> {
    const parts = chatId.split(":")
    if (parts.length < 3) return []
    const iid = parts.pop()!
    const noteableType = parts.pop()!
    const project = parts.join(":")

    const encodedProject = encodeURIComponent(project)
    let endpoint: string
    if (noteableType === "issue") {
      endpoint = `${this.config.host}/api/v4/projects/${encodedProject}/issues/${iid}/notes?sort=asc&per_page=${Math.max(20, Math.min(100, opts.maxMessages))}`
    } else if (noteableType === "merge_request") {
      endpoint = `${this.config.host}/api/v4/projects/${encodedProject}/merge_requests/${iid}/notes?sort=asc&per_page=${Math.max(20, Math.min(100, opts.maxMessages))}`
    } else {
      return []
    }

    // Use global token for the read — seedHistory is a context-rebuild
    // operation, not an identity-bound action, and the global token is
    // guaranteed to have read access across the configured projects.
    const token = this.config.token
    if (!token) return []

    let notes: Array<{
      id: number
      body: string
      author?: { username?: string; name?: string }
      created_at: string
      system?: boolean
    }>
    try {
      const res = await fetch(endpoint, {
        headers: { "PRIVATE-TOKEN": token },
      })
      if (!res.ok) return []
      notes = (await res.json()) as typeof notes
    } catch {
      return []
    }

    const out: SeededMessage[] = []
    let chars = 0
    const sinceMs = opts.sinceISO ? new Date(opts.sinceISO).getTime() : 0
    for (const n of notes) {
      if (n.system) continue // skip GitLab-generated "assigned to / closed" lines
      if (sinceMs && new Date(n.created_at).getTime() < sinceMs) continue
      const sourceAgent = detectAgentxMarker(n.body)
      const cleanBody = stripAgentxMarkers(n.body)
      out.push({
        role: sourceAgent ? "agent" : "user",
        name: n.author?.name || n.author?.username || (sourceAgent ?? "user"),
        content: cleanBody,
        timestamp: n.created_at,
        externalId: String(n.id),
      })
      chars += cleanBody.length
      if (out.length >= opts.maxMessages) break
      if (chars >= opts.maxChars) break
    }
    return out
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
    const mentionedUsers = text.match(/@(\w[\w.-]*)/g)?.map(m => m.slice(1).replace(/[.]+$/, "").toLowerCase()) || []
    for (const mapping of this.config.agentMappings) {
      if (mapping.token && mapping.gitlabUsernames.some(u => mentionedUsers.includes(u.toLowerCase()))) {
        return mapping.token
      }
    }
    return undefined
  }

  /**
   * React to a GitLab note with an emoji (👀 eyes) to acknowledge receipt.
   * ONLY uses the agent's own token — never the global token (which may
   * belong to a different agent user, causing the wrong identity to react).
   */
  private async reactToNote(project: string, noteableType: string, noteableIid: string, noteId: number, agentToken?: string, node?: string, agentId?: string): Promise<void> {
    // Agent lives on a remote mesh peer — forward the reaction request there
    if (!agentToken && node && agentId && this.reactForwarder) {
      this.log(`Forwarding 👀 reaction for "${agentId}" to mesh peer "${node}"`)
      await this.reactForwarder(node, project, noteableType, noteableIid, noteId, agentId)
      return
    }

    if (!agentToken) {
      this.log(`No token for reaction on note ${noteId} (agent "${agentId}") — skipping`)
      return
    }

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
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": agentToken,
        },
        body: JSON.stringify({ name: "eyes" }),
      })
      if (!res.ok) {
        this.log(`Reaction failed on note ${noteId}: ${res.status}`)
      }
    } catch (e: any) {
      this.log(`Failed to react to note ${noteId}: ${e.message}`)
    }
  }

  /**
   * Log time spent on a GitLab issue/MR after agent completes work.
   * Uses the /add_spent_time API endpoint.
   * chatId format: "project:type:iid" (e.g. "mtgl/mtgl-system-v2:issue:646")
   */
  async logTimeSpent(chatId: string, durationMs: number, agentId?: string): Promise<void> {
    const parts = chatId.split(":")
    if (parts.length < 3) return

    const iid = parts.pop()!
    const noteableType = parts.pop()!
    const project = parts.join(":")

    // Convert ms to GitLab duration string (minimum 1m)
    const totalSeconds = Math.max(60, Math.round(durationMs / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.ceil((totalSeconds % 3600) / 60)
    const duration = hours > 0 ? `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}` : `${minutes}m`

    const encodedProject = encodeURIComponent(project)
    const typeSegment = noteableType === "merge_request" ? "merge_requests" : "issues"
    const endpoint = `${this.config.host}/api/v4/projects/${encodedProject}/${typeSegment}/${iid}/add_spent_time`

    // Same identity rules as send(): for remote-hosted agents with no local
    // per-agent token, forward the time-log to the peer so it posts as the
    // agent's real GitLab user rather than the shared group bot.
    const mapping = this.config.agentMappings?.find((m) => m.agentId === agentId)
    const agentToken = this.getAgentToken(agentId)
    if (!agentToken && mapping?.node && this.logTimeForwarder) {
      try {
        await this.logTimeForwarder(mapping.node, project, noteableType, iid, agentId || "", durationMs)
        this.log(`Time logged (via peer "${mapping.node}"): ${duration} on ${project} ${typeSegment}/${iid} (${agentId})`)
      } catch (e: any) {
        this.log(`Time log forward to "${mapping.node}" failed: ${e.message} — skipping (would log as group bot)`)
      }
      return
    }

    const token = agentToken || this.config.token

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": token,
        },
        body: JSON.stringify({ duration }),
      })

      if (res.ok) {
        this.log(`Time logged: ${duration} on ${project} ${noteableType} #${iid} (${agentId || "global"})`)
      } else {
        const text = await res.text()
        this.log(`Time log failed (${res.status}): ${text.slice(0, 100)}`)
      }
    } catch (e: any) {
      this.log(`Time log error: ${e.message}`)
    }
  }

  /** Create a new GitLab issue. Mirrors `logTimeSpent`'s identity resolution:
   *  prefers the per-agent token; if the agent is hosted on a remote peer
   *  and no local token exists, forwards via mesh so the issue appears under
   *  the agent's real GitLab user. Returns `{ iid, url }` or null on failure. */
  async createIssue(args: {
    project: string
    title: string
    description?: string
    labels?: string[]
    assignees?: string[]
    agentId?: string
  }): Promise<{ iid: number; url: string } | null> {
    const { project, title, description = "", labels = [], assignees = [], agentId } = args
    const mapping = this.config.agentMappings?.find((m) => m.agentId === agentId)
    const agentToken = this.getAgentToken(agentId)

    // Remote-hosted agent with no local token — forward to peer.
    if (!agentToken && mapping?.node && this.createIssueForwarder) {
      try {
        const result = await this.createIssueForwarder(mapping.node, project, title, description, labels, assignees, agentId || "")
        if (result) this.log(`Issue created (via peer "${mapping.node}") #${result.iid} on ${project}`)
        return result
      } catch (e: any) {
        this.log(`Issue-create forward to "${mapping.node}" failed: ${e.message}`)
        return null
      }
    }

    const token = agentToken || this.config.token
    if (!token) {
      this.log(`Issue-create failed: no token available for agent "${agentId || "global"}"`)
      return null
    }

    const encodedProject = encodeURIComponent(project)
    const endpoint = `${this.config.host}/api/v4/projects/${encodedProject}/issues`
    const body = new URLSearchParams()
    body.set("title", title)
    if (description) body.set("description", description)
    if (labels.length > 0) body.set("labels", labels.join(","))
    // GitLab takes `assignee_ids[]`; users pass usernames for ergonomics,
    // so resolve them to numeric ids first. Failure to resolve any one
    // assignee is logged but doesn't block the create.
    for (const username of assignees) {
      try {
        const r = await fetch(`${this.config.host}/api/v4/users?username=${encodeURIComponent(username)}`, {
          headers: { "PRIVATE-TOKEN": token },
        })
        if (r.ok) {
          const users = await r.json() as Array<{ id: number }>
          if (users[0]?.id) body.append("assignee_ids[]", String(users[0].id))
        }
      } catch (e: any) {
        this.log(`Issue-create: failed to resolve assignee "${username}": ${e.message}`)
      }
    }

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "PRIVATE-TOKEN": token,
        },
        body: body.toString(),
      })
      if (!res.ok) {
        const text = await res.text()
        this.log(`Issue-create failed (${res.status}): ${text.slice(0, 200)}`)
        return null
      }
      const issue = await res.json() as { iid: number; web_url: string }
      this.log(`Issue created #${issue.iid} on ${project} (${agentId || "global"})`)
      return { iid: issue.iid, url: issue.web_url }
    } catch (e: any) {
      this.log(`Issue-create error: ${e.message}`)
      return null
    }
  }

  /** Add / remove labels on an existing issue or MR. Same identity
   *  resolution as createIssue: per-agent token > mesh-forward to home > global.
   *  Returns the updated label set on success, or null. */
  async setLabels(args: {
    project: string
    kind?: "issue" | "merge_request"
    iid: string
    add?: string[]
    remove?: string[]
    agentId?: string
  }): Promise<string[] | null> {
    const { project, kind = "issue", iid, add = [], remove = [], agentId } = args
    const mapping = this.config.agentMappings?.find((m) => m.agentId === agentId)
    const agentToken = this.getAgentToken(agentId)

    if (!agentToken && mapping?.node && this.setLabelsForwarder) {
      try {
        const labels = await this.setLabelsForwarder(mapping.node, project, kind, iid, add, remove, agentId || "")
        if (labels) this.log(`Labels updated (via peer "${mapping.node}") on ${project} ${kind}/${iid}`)
        return labels
      } catch (e: any) {
        this.log(`setLabels forward to "${mapping.node}" failed: ${e.message}`)
        return null
      }
    }
    const token = agentToken || this.config.token
    if (!token) { this.log(`setLabels failed: no token for "${agentId || "global"}"`); return null }

    const segment = kind === "merge_request" ? "merge_requests" : "issues"
    const endpoint = `${this.config.host}/api/v4/projects/${encodeURIComponent(project)}/${segment}/${iid}`
    const body = new URLSearchParams()
    if (add.length) body.set("add_labels", add.join(","))
    if (remove.length) body.set("remove_labels", remove.join(","))

    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "PRIVATE-TOKEN": token },
        body: body.toString(),
      })
      if (!res.ok) {
        const text = await res.text()
        this.log(`setLabels failed (${res.status}): ${text.slice(0, 200)}`)
        return null
      }
      const data = await res.json() as { labels?: string[] }
      return data.labels ?? []
    } catch (e: any) {
      this.log(`setLabels error: ${e.message}`)
      return null
    }
  }

  /** Read current labels on an issue or MR. Read-only, so doesn't need
   *  per-agent identity. Uses the global token. */
  async getLabels(args: { project: string; kind?: "issue" | "merge_request"; iid: string }): Promise<string[] | null> {
    const { project, kind = "issue", iid } = args
    if (!this.config.token) return null
    const segment = kind === "merge_request" ? "merge_requests" : "issues"
    const endpoint = `${this.config.host}/api/v4/projects/${encodeURIComponent(project)}/${segment}/${iid}`
    try {
      const res = await fetch(endpoint, { headers: { "PRIVATE-TOKEN": this.config.token } })
      if (!res.ok) { this.log(`getLabels failed (${res.status})`); return null }
      const data = await res.json() as { labels?: string[] }
      return data.labels ?? []
    } catch (e: any) {
      this.log(`getLabels error: ${e.message}`)
      return null
    }
  }

  /**
   * Extract and download images from a GitLab comment.
   * GitLab markdown images: ![alt](/uploads/hash/filename.png)
   * Returns the first image found as media attachment, or undefined.
   */
  private async downloadNoteImages(
    note: string,
    project: string,
    token: string,
  ): Promise<IncomingMessage["media"] | undefined> {
    // Match GitLab upload paths: ![...](/uploads/...) or full URLs
    const imagePattern = /!\[[^\]]*\]\(([^)]+\.(?:png|jpg|jpeg|gif|webp|svg))\)/gi
    const matches = [...note.matchAll(imagePattern)]
    if (matches.length === 0) return undefined

    const imagePath = matches[0][1] // First image
    let imageUrl: string

    if (imagePath.startsWith("http")) {
      imageUrl = imagePath
    } else {
      // Relative path — resolve against GitLab project
      const encodedProject = encodeURIComponent(project)
      imageUrl = `${this.config.host}/${project}${imagePath}`
    }

    try {
      const res = await fetch(imageUrl, {
        headers: { "PRIVATE-TOKEN": token },
      })
      if (!res.ok) {
        this.log(`Failed to download image: ${res.status} ${imageUrl}`)
        return undefined
      }

      const buffer = Buffer.from(await res.arrayBuffer())
      const contentType = res.headers.get("content-type") || "image/png"
      const ext = contentType.split("/")[1]?.split(";")[0] || "png"

      // Save to disk
      const { mkdirSync, writeFileSync } = await import("fs")
      const { resolve } = await import("path")
      const { randomUUID } = await import("crypto")
      const mediaDir = resolve(process.cwd(), ".agentx/media/gitlab")
      mkdirSync(mediaDir, { recursive: true })
      const fileName = `${randomUUID().slice(0, 8)}.${ext}`
      const filePath = resolve(mediaDir, fileName)
      writeFileSync(filePath, buffer)

      this.log(`Downloaded GitLab image: ${filePath} (${buffer.length} bytes)`)

      return {
        path: filePath,
        type: contentType,
        fileName: imagePath.split("/").pop() || fileName,
      }
    } catch (e: any) {
      this.log(`Image download error: ${e.message}`)
      return undefined
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
