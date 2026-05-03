import type { ChannelAdapter, IncomingMessage, OutgoingMessage, ChannelMeta } from "./types"
import { createHmac, createSign } from "crypto"
import { readFileSync } from "fs"
import { debug } from "@/observability/debug"
import { markBody, detectAgentxMarker } from "./outbound-marker"

// --- GitHub webhook channel adapter ---
//
// Receives GitHub webhook events (issue_comment, pull_request, push, etc.)
// and routes them to agents. Agents reply as GitHub API comments.
//
// Config (channels.github):
//   enabled: true
//   token: "${GITHUB_TOKEN}"         # PAT for posting comments
//   tokenFile: "/path/to/token"      # alternative: read token from file
//   webhookSecret: "secret"          # validates X-Hub-Signature-256
//   routes:
//     - repo: "owner/repo"
//       agent: "coder-agent"
//     - repo: "*"
//       agent: "atlas"
//   agentMappings:
//     - agentId: "coder-agent"
//       githubUsernames: ["my-bot"]
//       node: "macbook-local"        # forward to mesh peer

export interface GitHubRoute {
  repo: string   // "owner/repo" or "*" for default
  agent: string
}

export interface GitHubAgentMapping {
  agentId: string
  githubUsernames: string[]
  token?: string
  tokenFile?: string
  node?: string   // mesh peer for remote agents
}

export interface GitHubChannelConfig {
  /** PAT-based auth (legacy — comments appear as the token owner) */
  token?: string
  tokenFile?: string
  /** GitHub App auth (comments appear as the app bot) */
  appId?: number
  /** Client ID (preferred JWT issuer per GitHub's updated docs). */
  clientId?: string
  privateKeyFile?: string
  /** Webhook secret for validating X-Hub-Signature-256. */
  webhookSecret?: string
  routes: GitHubRoute[]
  agentMappings?: GitHubAgentMapping[]
}

// --- GitHub event type definitions ---

interface GitHubUser {
  login: string
  id: number
}

interface GitHubRepo {
  full_name: string
  html_url: string
}

interface GitHubIssueCommentEvent {
  action: string  // "created", "edited", "deleted"
  comment: {
    id: number
    body: string
    html_url: string
    user: GitHubUser
  }
  issue: {
    number: number
    title: string
    state: string
    html_url: string
    pull_request?: unknown  // present if this is a PR
  }
  repository: GitHubRepo
}

interface GitHubPREvent {
  action: string
  pull_request: {
    number: number
    title: string
    state: string
    body: string
    html_url: string
    head: { ref: string }
    base: { ref: string }
    user: GitHubUser
  }
  repository: GitHubRepo
}

interface GitHubPRReviewEvent {
  action: string
  review: {
    id: number
    body: string
    state: string  // "approved", "changes_requested", "commented"
    html_url: string
    user: GitHubUser
  }
  pull_request: {
    number: number
    title: string
    html_url: string
  }
  repository: GitHubRepo
}

interface GitHubPRReviewCommentEvent {
  action: string
  comment: {
    id: number
    body: string
    html_url: string
    path: string
    line: number
    user: GitHubUser
  }
  pull_request: {
    number: number
    title: string
    html_url: string
  }
  repository: GitHubRepo
}

interface GitHubPushEvent {
  ref: string
  commits: Array<{
    id: string
    message: string
    author: { name: string; username: string }
  }>
  repository: GitHubRepo
  pusher: { name: string }
}

interface GitHubIssueEvent {
  action: string
  issue: {
    number: number
    title: string
    body: string
    state: string
    html_url: string
    user: GitHubUser
    assignees: GitHubUser[]
  }
  repository: GitHubRepo
}

type GitHubEvent = GitHubIssueCommentEvent | GitHubPREvent | GitHubPRReviewEvent
  | GitHubPRReviewCommentEvent | GitHubPushEvent | GitHubIssueEvent | Record<string, unknown>

export class GitHubAdapter implements ChannelAdapter {
  readonly name = "github"
  private config: GitHubChannelConfig
  private handler?: (msg: IncomingMessage) => Promise<void>
  private globalToken?: string
  private botUsernames: Set<string> = new Set()
  private sentCommentIds: Set<string> = new Set()
  private log: (...args: unknown[]) => void
  private sendCommentForwarder?: (node: string, repo: string, issueNumber: number, agentId: string, text: string) => Promise<string>
  // GitHub App auth state
  private appPrivateKey?: string
  private installationTokens: Map<string, { token: string; expiresAt: number }> = new Map()

  constructor(config: GitHubChannelConfig, log: (...args: unknown[]) => void = console.error.bind(console, "[github]")) {
    this.config = config
    this.log = log
  }

  setSendCommentForwarder(fn: (node: string, repo: string, issueNumber: number, agentId: string, text: string) => Promise<string>): void {
    this.sendCommentForwarder = fn
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    // GitHub App auth (preferred — posts as the app bot identity)
    const hasAppAuth = (this.config.clientId || this.config.appId) && this.config.privateKeyFile
    if (hasAppAuth) {
      try {
        this.appPrivateKey = readFileSync(this.config.privateKeyFile!, "utf-8").trim()
        this.log(`GitHub App mode: issuer=${this.config.clientId || this.config.appId}`)

        // Verify the app works by fetching app info
        const jwt = this.generateAppJWT()
        const res = await fetch("https://api.github.com/app", {
          headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "AgentX" },
        })
        if (res.ok) {
          const data = await res.json() as any
          this.log(`GitHub App: "${data.name}" (slug: ${data.slug})`)
          // Add the app's bot username to cascade prevention
          if (data.slug) this.botUsernames.add(`${data.slug}[bot]`.toLowerCase())
        } else {
          this.log(`GitHub App auth failed: ${res.status} ${await res.text().catch(() => "")}`)
        }
      } catch (e: any) {
        this.log(`Failed to load GitHub App key: ${e.message}`)
      }
    }

    // PAT fallback (legacy — posts as token owner)
    if (!this.appPrivateKey) {
      this.globalToken = this.resolveToken(this.config.token, this.config.tokenFile)
      if (this.globalToken) {
        try {
          const res = await fetch("https://api.github.com/user", {
            headers: { Authorization: `Bearer ${this.globalToken}`, "User-Agent": "AgentX" },
          })
          if (res.ok) {
            const data = await res.json() as any
            this.log(`GitHub PAT fallback: ${data.login}`)
          }
        } catch (e: any) {
          this.log(`Failed to resolve GitHub user: ${e.message}`)
        }
      }
    }

    // Register agent mapping usernames for cascade prevention
    for (const mapping of this.config.agentMappings || []) {
      for (const username of mapping.githubUsernames) {
        this.botUsernames.add(username.toLowerCase())
      }
    }

    this.log(`GitHub channel started (${this.config.routes.length} routes, ${this.botUsernames.size} bot users)`)
  }

  async stop(): Promise<void> {
    // No persistent server — webhooks come through the main daemon HTTP server
  }

  /**
   * Handle an incoming webhook request from the daemon's HTTP server.
   * Called by the daemon when it detects a GitHub webhook (X-GitHub-Event header).
   * @param rawBody - raw request body string, needed for signature verification
   */
  async handleWebhook(headers: Record<string, string | string[] | undefined>, body: Record<string, unknown>, rawBody?: string): Promise<void> {
    // Validate signature
    if (this.config.webhookSecret) {
      const signature = headers["x-hub-signature-256"] as string
      const payload = rawBody || JSON.stringify(body)
      if (!this.verifySignature(payload, signature)) {
        this.log("GitHub webhook signature verification failed")
        return
      }
    }

    const event = headers["x-github-event"] as string || "unknown"
    const repo = (body.repository as any)?.full_name || "unknown"
    this.log(`GitHub event: ${event} from ${repo}`)

    switch (event) {
      case "issue_comment":
        await this.handleIssueComment(body as unknown as GitHubIssueCommentEvent)
        break
      case "pull_request":
        await this.handlePR(body as unknown as GitHubPREvent)
        break
      case "pull_request_review":
        await this.handlePRReview(body as unknown as GitHubPRReviewEvent)
        break
      case "pull_request_review_comment":
        await this.handlePRReviewComment(body as unknown as GitHubPRReviewCommentEvent)
        break
      case "issues":
        await this.handleIssue(body as unknown as GitHubIssueEvent)
        break
      case "push":
        await this.handlePush(body as unknown as GitHubPushEvent)
        break
      case "ping":
        this.log("GitHub webhook ping received")
        break
      default:
        this.log(`Unhandled GitHub event: ${event}`)
    }
  }

  /**
   * Send a reply — posts a comment on a GitHub issue or PR.
   * chatId format: "owner/repo:issue:123" or "owner/repo:pull:456"
   */
  async send(msg: OutgoingMessage): Promise<string> {
    const parts = msg.chatId.split(":")
    if (parts.length < 3) {
      this.log(`Invalid chatId for GitHub reply: ${msg.chatId}`)
      return ""
    }
    const issueNumber = parseInt(parts.pop()!, 10)
    const type = parts.pop()! // "issue" or "pull"
    const repo = parts.join(":")

    // Identity: use per-agent token, forward via mesh, or fall back to global
    const mapping = this.config.agentMappings?.find(m => m.agentId === msg.agentId)
    const agentToken = this.getAgentToken(msg.agentId)

    // Build comment body — when using App auth the bot identity is implicit,
    // so we only add the agent header for PAT mode.
    const agentLabel = msg.agentId || "unknown"
    const usingApp = !!this.appPrivateKey
    const agentHeader = usingApp ? "" : `> 🤖 **${agentLabel}** (via AgentX)\n\n`
    const commentBody = markBody(`${agentHeader}${msg.text}`, agentLabel)

    // Resolve token: per-agent PAT > App installation token > global PAT.
    // Prefer the App token over forwarding to a peer — the App posts as the
    // bot identity (e.g. "noqta-agentx[bot]"), whereas a peer's PAT posts as
    // its owner. Forwarding is only useful when this node has no way to post
    // for the target repo (no App, no PAT).
    const token = agentToken || await this.getTokenForRepo(repo)

    // Fall back to forwarding to a peer (e.g. macbook's PAT) only when this
    // node cannot post for the repo at all.
    if (!token && mapping?.node && this.sendCommentForwarder) {
      try {
        const commentId = await this.sendCommentForwarder(mapping.node, repo, issueNumber, agentLabel, commentBody)
        if (commentId) {
          this.sentCommentIds.add(commentId)
          return commentId
        }
        this.log(`GitHub send forward to "${mapping.node}" returned empty — no local token available either`)
      } catch (e: any) {
        this.log(`GitHub send forward to "${mapping.node}" failed: ${e.message}`)
      }
    }

    if (!token) {
      this.log(`No GitHub token available for posting comment (agent: ${msg.agentId})`)
      return ""
    }

    const endpoint = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "AgentX",
        },
        body: JSON.stringify({ body: commentBody }),
      })
      if (!res.ok) {
        const text = await res.text()
        this.log(`GitHub API error: ${res.status} ${text.slice(0, 200)}`)
        return ""
      }
      const data = await res.json() as any
      const commentId = String(data.id || "")
      if (commentId) this.sentCommentIds.add(commentId)
      return commentId
    } catch (e: any) {
      this.log(`GitHub send error: ${e.message}`)
      return ""
    }
  }

  async react(chatId: string, messageId: string, emoji?: string): Promise<void> {
    // GitHub reactions on comments: POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions
    const parts = chatId.split(":")
    if (parts.length < 3) return
    parts.pop() // issue number
    parts.pop() // type
    const repo = parts.join(":")
    const token = await this.getTokenForRepo(repo)
    if (!token || !messageId) return

    try {
      await fetch(`https://api.github.com/repos/${repo}/issues/comments/${messageId}/reactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "AgentX",
        },
        body: JSON.stringify({ content: "eyes" }),
      })
    } catch { /* best effort */ }
  }

  async getChannelMeta(chatId: string): Promise<ChannelMeta | undefined> {
    const parts = chatId.split(":")
    const repo = parts[0] + (parts.length > 1 ? "" : "")
    const type = parts.length >= 2 ? parts[parts.length - 2] : undefined
    const number = parts.length >= 3 ? parts[parts.length - 1] : undefined

    // Rebuild repo from all parts except last two
    const repoParts = parts.slice(0, -2)
    const repoName = repoParts.length > 0 ? repoParts.join(":") : parts[0]

    const agents: ChannelMeta["agents"] = []
    for (const route of this.config.routes) {
      if (route.repo === repoName || route.repo === "*") {
        agents.push({ id: route.agent, name: route.agent })
      }
    }

    return {
      channel: "github",
      agents,
      project: repoName,
      issue: type && number ? { type, iid: number, title: "" } : undefined,
      facts: [
        "This is a GitHub webhook event — respond as a GitHub comment",
        "Use `gh` CLI or the GitHub API to interact with the repository",
        "Do NOT use Telegram handles or delegate to other agents",
      ],
    }
  }

  // --- Event handlers ---

  private async handleIssueComment(event: GitHubIssueCommentEvent): Promise<void> {
    if (!this.handler) {
      this.log(`[github] issue_comment dropped: no handler attached`)
      return
    }
    if (event.action !== "created") {
      this.log(`[github] issue_comment skipped: action="${event.action}" (only "created" routes)`)
      return
    }

    const comment = event.comment
    const repo = event.repository.full_name
    const user = comment.user

    // Cascade prevention: check for AgentX signature
    const sourceAgent = detectAgentxMarker(comment.body)
    if (sourceAgent) {
      this.log(`AgentX comment from ${sourceAgent}, skipping (comment ${comment.id})`)
      return
    }

    // Skip comments from known bot users (e.g. noqta-agentx[bot] when using App auth)
    if (this.isBotUser(user.login)) {
      this.log(`Bot user ${user.login}, skipping (comment ${comment.id})`)
      return
    }

    const commentId = String(comment.id)
    if (this.sentCommentIds.has(commentId)) {
      this.log(`[github] echo skip: comment ${commentId} matched our own post`)
      this.sentCommentIds.delete(commentId)
      return
    }

    const isPR = !!event.issue.pull_request
    const type = isPR ? "pull" : "issue"
    const chatId = `${repo}:${type}:${event.issue.number}`
    const agentId = this.resolveAgent(repo)
    const mapping = agentId ? this.config.agentMappings?.find(m => m.agentId === agentId) : undefined

    const channelMeta = await this.getChannelMeta(chatId)

    const incoming: IncomingMessage = {
      id: commentId,
      channel: "github",
      accountId: "default",
      sender: {
        id: chatId,
        name: user.login,
        username: user.login,
      },
      text: `[GitHub ${isPR ? "PR" : "Issue"} #${event.issue.number}: ${event.issue.title}]\n${user.login} commented:\n${comment.body}`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: agentId,
      preferNode: mapping?.node,
      channelMeta,
    }

    // React with 👀
    this.reactToComment(repo, comment.id).catch(() => {})

    this.handler(incoming).catch(e => this.log(`Error handling issue_comment: ${e.message}`))
  }

  private async handlePR(event: GitHubPREvent): Promise<void> {
    if (!this.handler) return

    const pr = event.pull_request
    const repo = event.repository.full_name

    // Skip bot PRs
    if (this.isBotUser(pr.user.login)) return

    // Only handle actionable events
    const actionable = ["opened", "reopened", "ready_for_review"]
    if (!actionable.includes(event.action)) return

    const chatId = `${repo}:pull:${pr.number}`
    const agentId = this.resolveAgent(repo)
    const mapping = agentId ? this.config.agentMappings?.find(m => m.agentId === agentId) : undefined

    const channelMeta = await this.getChannelMeta(chatId)

    const incoming: IncomingMessage = {
      id: `pr-${repo}-${pr.number}`,
      channel: "github",
      accountId: "default",
      sender: {
        id: chatId,
        name: pr.user.login,
        username: pr.user.login,
      },
      text: `[GitHub PR #${pr.number} ${event.action}]: ${pr.title}\nBranch: ${pr.head.ref} -> ${pr.base.ref}\n${pr.body?.slice(0, 500) || ""}\nURL: ${pr.html_url}`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: agentId,
      preferNode: mapping?.node,
      channelMeta,
    }

    this.handler(incoming).catch(e => this.log(`Error handling PR: ${e.message}`))
  }

  private async handlePRReview(event: GitHubPRReviewEvent): Promise<void> {
    if (!this.handler || event.action !== "submitted") return

    const review = event.review
    const repo = event.repository.full_name

    if (this.isBotUser(review.user.login)) return

    // Only handle reviews with actual content
    if (review.state === "commented" && !review.body) return

    const chatId = `${repo}:pull:${event.pull_request.number}`
    const agentId = this.resolveAgent(repo)
    const mapping = agentId ? this.config.agentMappings?.find(m => m.agentId === agentId) : undefined

    const incoming: IncomingMessage = {
      id: `review-${review.id}`,
      channel: "github",
      accountId: "default",
      sender: {
        id: chatId,
        name: review.user.login,
        username: review.user.login,
      },
      text: `[GitHub PR #${event.pull_request.number} Review (${review.state})]: ${event.pull_request.title}\n${review.user.login} reviewed:\n${review.body || "(no body)"}`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: agentId,
      preferNode: mapping?.node,
    }

    this.handler(incoming).catch(e => this.log(`Error handling PR review: ${e.message}`))
  }

  private async handlePRReviewComment(event: GitHubPRReviewCommentEvent): Promise<void> {
    if (!this.handler || event.action !== "created") return

    const comment = event.comment
    const repo = event.repository.full_name

    if (this.isBotUser(comment.user.login)) return

    // Skip AgentX-signed comments
    if (detectAgentxMarker(comment.body)) return

    const chatId = `${repo}:pull:${event.pull_request.number}`
    const agentId = this.resolveAgent(repo)
    const mapping = agentId ? this.config.agentMappings?.find(m => m.agentId === agentId) : undefined

    const incoming: IncomingMessage = {
      id: `review-comment-${comment.id}`,
      channel: "github",
      accountId: "default",
      sender: {
        id: chatId,
        name: comment.user.login,
        username: comment.user.login,
      },
      text: `[GitHub PR #${event.pull_request.number} Review Comment]: ${event.pull_request.title}\n${comment.user.login} commented on ${comment.path}:${comment.line}:\n${comment.body}`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: agentId,
      preferNode: mapping?.node,
    }

    this.handler(incoming).catch(e => this.log(`Error handling PR review comment: ${e.message}`))
  }

  private async handleIssue(event: GitHubIssueEvent): Promise<void> {
    if (!this.handler) return

    const issue = event.issue
    const repo = event.repository.full_name

    if (this.isBotUser(issue.user.login)) return

    const actionable = ["opened", "assigned", "reopened"]
    if (!actionable.includes(event.action)) return

    const chatId = `${repo}:issue:${issue.number}`
    const agentId = this.resolveAgent(repo)
    const mapping = agentId ? this.config.agentMappings?.find(m => m.agentId === agentId) : undefined

    const incoming: IncomingMessage = {
      id: `issue-${repo}-${issue.number}`,
      channel: "github",
      accountId: "default",
      sender: {
        id: chatId,
        name: issue.user.login,
        username: issue.user.login,
      },
      text: `[GitHub Issue #${issue.number} ${event.action}]: ${issue.title}\n${issue.body?.slice(0, 500) || ""}\nURL: ${issue.html_url}`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: agentId,
      preferNode: mapping?.node,
    }

    this.handler(incoming).catch(e => this.log(`Error handling issue: ${e.message}`))
  }

  private async handlePush(event: GitHubPushEvent): Promise<void> {
    if (!this.handler) return

    const repo = event.repository.full_name
    const ref = event.ref
    const commits = event.commits || []
    if (commits.length === 0) return

    const agentId = this.resolveAgent(repo)
    const mapping = agentId ? this.config.agentMappings?.find(m => m.agentId === agentId) : undefined

    const commitSummary = commits.slice(0, 5).map(c =>
      `  - ${c.message.split("\n")[0]} (${c.author?.name || c.author?.username || ""})`
    ).join("\n")

    const incoming: IncomingMessage = {
      id: `push-${commits[0]?.id?.slice(0, 8) || Date.now()}`,
      channel: "github",
      accountId: "default",
      sender: {
        id: `${repo}:push:${ref}`,
        name: event.pusher.name,
        username: event.pusher.name,
      },
      text: `[GitHub Push] ${repo} ref:${ref}\n${commits.length} commit(s):\n${commitSummary}`,
      timestamp: new Date(),
      raw: event,
      resolvedAgent: agentId,
      preferNode: mapping?.node,
    }

    this.handler(incoming).catch(e => this.log(`Error handling push: ${e.message}`))
  }

  // --- Helpers ---

  private resolveAgent(repo: string): string | undefined {
    for (const route of this.config.routes) {
      if (route.repo === repo || route.repo === "*") {
        return route.agent
      }
    }
    return undefined
  }

  private isBotUser(username: string): boolean {
    return this.botUsernames.has(username.toLowerCase())
  }

  private getAgentToken(agentId?: string): string | undefined {
    if (!agentId || !this.config.agentMappings?.length) return undefined
    const mapping = this.config.agentMappings.find(m => m.agentId === agentId)
    if (!mapping) return undefined
    return this.resolveToken(mapping.token, mapping.tokenFile)
  }

  private resolveToken(token?: string, tokenFile?: string): string | undefined {
    if (token) return token
    if (tokenFile) {
      try {
        return readFileSync(tokenFile, "utf-8").trim().split("\n")[0].trim()
      } catch (e: any) {
        this.log(`Failed to read token file ${tokenFile}: ${e.message}`)
      }
    }
    return undefined
  }

  private verifySignature(payload: string, signature?: string): boolean {
    if (!signature || !this.config.webhookSecret) return false
    const expected = "sha256=" + createHmac("sha256", this.config.webhookSecret).update(payload).digest("hex")
    return signature === expected
  }

  private async reactToComment(repo: string, commentId: number): Promise<void> {
    const token = await this.getTokenForRepo(repo)
    if (!token) return
    try {
      await fetch(`https://api.github.com/repos/${repo}/issues/comments/${commentId}/reactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "AgentX",
        },
        body: JSON.stringify({ content: "eyes" }),
      })
    } catch { /* best effort */ }
  }

  // --- GitHub App auth ---

  /**
   * Get a valid token for a given repo.
   * Prefers GitHub App installation token, falls back to PAT.
   */
  async getTokenForRepo(repo?: string): Promise<string | undefined> {
    if (this.appPrivateKey && this.config.appId && repo) {
      const token = await this.getInstallationToken(repo)
      if (token) return token
    }
    return this.globalToken
  }

  /**
   * Generate a JWT signed with the GitHub App private key.
   * Valid for 10 minutes (GitHub's max).
   */
  private generateAppJWT(): string {
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      iat: now - 60,      // issued at (60s clock skew buffer)
      exp: now + 600,     // expires in 10 min
      iss: this.config.clientId || String(this.config.appId),
    }

    // Build JWT manually (header.payload.signature)
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
    const unsigned = `${header}.${body}`

    const sign = createSign("RSA-SHA256")
    sign.update(unsigned)
    const signature = sign.sign(this.appPrivateKey!, "base64url")

    return `${unsigned}.${signature}`
  }

  /**
   * Get an installation access token for a repo.
   * Caches tokens until they expire (1 hour).
   */
  private async getInstallationToken(repo: string): Promise<string | undefined> {
    // Check cache
    const cached = this.installationTokens.get(repo)
    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached.token
    }

    try {
      const jwt = this.generateAppJWT()

      // Find installation for this repo
      const installRes = await fetch(`https://api.github.com/repos/${repo}/installation`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "AgentX",
        },
      })
      if (!installRes.ok) {
        this.log(`GitHub App not installed on ${repo}: ${installRes.status}`)
        return undefined
      }
      const install = await installRes.json() as any

      // Create installation access token
      const tokenRes = await fetch(`https://api.github.com/app/installations/${install.id}/access_tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "AgentX",
        },
      })
      if (!tokenRes.ok) {
        this.log(`Failed to get installation token for ${repo}: ${tokenRes.status}`)
        return undefined
      }
      const tokenData = await tokenRes.json() as any
      const expiresAt = new Date(tokenData.expires_at).getTime()

      this.installationTokens.set(repo, { token: tokenData.token, expiresAt })
      this.log(`Got installation token for ${repo} (expires: ${tokenData.expires_at})`)
      return tokenData.token
    } catch (e: any) {
      this.log(`Installation token error for ${repo}: ${e.message}`)
      return undefined
    }
  }
}
