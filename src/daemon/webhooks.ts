import type { IncomingMessage, ServerResponse } from "http"
import { createHmac, timingSafeEqual } from "crypto"
import type { AgentRegistry } from "@/agents/registry"
import type { A2AMesh } from "@/a2a/mesh"
import type { DaemonConfig } from "./config"

// --- Webhook handler ---
// Routes incoming webhooks from GitLab, GitHub, Stripe, Sentry, etc.
// to the appropriate agent with parsed payload context.
//
// Endpoints:
//   POST /webhook/:agentId                — route to specific agent
//   POST /webhook/:agentId/:source        — route with source hint (gitlab, github, etc.)
//
// The webhook payload is parsed and a human-readable summary is built
// so the agent doesn't need to parse raw JSON.

interface WebhookConfig {
  /** Secret for validating webhook signatures (optional) */
  secrets?: Record<string, string>  // source -> secret
}

export class WebhookHandler {
  private registry: AgentRegistry
  private config: WebhookConfig
  private mesh?: A2AMesh
  private webhookEntries: DaemonConfig["webhooks"]
  private log: (...args: unknown[]) => void

  constructor(
    registry: AgentRegistry,
    config: WebhookConfig = {},
    log: (...args: unknown[]) => void = console.error.bind(console, "[webhook]"),
    mesh?: A2AMesh,
    webhookEntries: DaemonConfig["webhooks"] = [],
  ) {
    this.registry = registry
    this.config = config
    this.log = log
    this.mesh = mesh
    this.webhookEntries = webhookEntries
  }

  /**
   * Handle an incoming webhook request.
   * URL format: /webhook/:agentId or /webhook/:agentId/:source
   */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    // Parse path: /webhook/<agentId> or /webhook/<agentId>/<source>
    const parts = path.replace(/^\/webhook\/?/, "").split("/").filter(Boolean)
    const agentId = parts[0]
    const sourceHint = parts[1] // optional: "gitlab", "github", "stripe", "sentry"

    if (!agentId) {
      this.sendJson(res, 400, { error: "Missing agent ID. Use /webhook/:agentId" })
      return
    }

    // Read raw body bytes BEFORE JSON parsing — HMAC signatures are over
    // the wire bytes; parsing-then-reserializing breaks GitHub's, Stripe's,
    // and most providers' signature schemes (key ordering, whitespace).
    const { raw, parsed } = await this.readBody(req)

    // Detect source from headers if not in URL
    const source = sourceHint || this.detectSource(req.headers)

    // Mandatory signature check when the matching webhook entry has
    // `secretEnv` set. Silent no-op was the prior behavior — that's a
    // security trap: an operator configures a secret expecting protection,
    // gets none. Reject 401 instead.
    const sigError = this.validateSignature(req.headers, raw, source, agentId)
    if (sigError) {
      this.log(`Webhook [${source}] -> ${agentId}: REJECTED (${sigError})`)
      this.sendJson(res, 401, { error: sigError })
      return
    }

    // Parse the webhook payload into a human-readable message
    const summary = this.buildSummary(source, parsed, req.headers)

    this.log(`Webhook [${source}] -> ${agentId}: ${summary.slice(0, 100)}`)

    // Check if there's a webhook entry with mesh routing
    const meshEntry = this.webhookEntries.find(
      w => w.enabled && w.node && w.agentId === agentId && w.source === source,
    )

    if (meshEntry?.node && this.mesh) {
      // Respond immediately — GitHub/GitLab have short delivery timeouts.
      // Forward to mesh peer asynchronously.
      this.sendJson(res, 202, {
        ok: true,
        agent: agentId,
        source,
        node: meshEntry.node,
        status: "accepted",
      })
      this.mesh.sendTask(meshEntry.node, summary, agentId).then(
        (response) => this.log(`Mesh-forwarded webhook [${source}] -> ${meshEntry.node}/${agentId}: ${response?.slice(0, 100) || "ok"}`),
        (e: any) => this.log(`Mesh forward failed [${source}] -> ${meshEntry.node}/${agentId}: ${e.message}`),
      )
      return
    }

    // Execute on the local agent — pass `parsed` instead of re-parsing
    try {
      const response = await this.registry.execute({
        message: summary,
        agentId,
        context: {
          channel: `webhook:${source}`,
          sender: `webhook:${source}`,
        },
      })

      this.sendJson(res, response.error ? 500 : 200, {
        ok: !response.error,
        agent: agentId,
        source,
        response: response.content?.slice(0, 500),
        error: response.error,
        duration: response.duration,
      })
    } catch (e: any) {
      this.sendJson(res, 500, { error: e.message })
    }
  }

  /**
   * Detect webhook source from request headers.
   */
  private detectSource(headers: Record<string, string | string[] | undefined>): string {
    if (headers["x-gitlab-event"] || headers["x-gitlab-token"]) return "gitlab"
    if (headers["x-github-event"]) return "github"
    if (headers["stripe-signature"]) return "stripe"
    if (headers["sentry-hook-resource"]) return "sentry"
    if (headers["x-vercel-signature"]) return "vercel"
    if (headers["x-hub-signature-256"]) return "github"
    return "unknown"
  }

  /**
   * Build a human-readable summary from the webhook payload.
   * Agent reads this instead of raw JSON.
   */
  private buildSummary(source: string, body: Record<string, unknown>, headers: Record<string, string | string[] | undefined>): string {
    const lines: string[] = [`[Webhook from ${source}]`]

    switch (source) {
      case "gitlab": {
        const event = headers["x-gitlab-event"] as string || body.object_kind as string || "event"
        const project = (body.project as any)?.path_with_namespace || ""
        const user = (body.user as any)?.name || (body.user_username as string) || ""

        lines.push(`Event: ${event}`)
        if (project) lines.push(`Project: ${project}`)
        if (user) lines.push(`User: ${user}`)

        // Push events
        if (body.ref) lines.push(`Ref: ${body.ref}`)
        if (body.commits && Array.isArray(body.commits)) {
          lines.push(`Commits: ${body.commits.length}`)
          for (const c of (body.commits as any[]).slice(0, 3)) {
            lines.push(`  - ${c.message?.split("\n")[0] || "no message"} (${c.author?.name || ""})`)
          }
        }

        // MR events
        const mr = body.object_attributes as any
        if (mr?.title) {
          lines.push(`Title: ${mr.title}`)
          lines.push(`State: ${mr.state || ""}`)
          lines.push(`Action: ${mr.action || ""}`)
          if (mr.source_branch) lines.push(`Branch: ${mr.source_branch} -> ${mr.target_branch}`)
          if (mr.url) lines.push(`URL: ${mr.url}`)
        }

        // Issue events
        if (mr?.iid && !mr?.source_branch) {
          lines.push(`Issue #${mr.iid}: ${mr.title || ""}`)
          if (mr.description) lines.push(`Description: ${mr.description.slice(0, 200)}`)
        }

        // Pipeline events
        if (body.object_kind === "pipeline") {
          const attrs = body.object_attributes as any
          lines.push(`Pipeline: ${attrs?.status || ""} (${attrs?.ref || ""})`)
          lines.push(`Duration: ${attrs?.duration || 0}s`)
        }
        break
      }

      case "github": {
        const event = headers["x-github-event"] as string || "event"
        const repo = (body.repository as any)?.full_name || ""
        const sender = (body.sender as any)?.login || ""

        lines.push(`Event: ${event}`)
        if (repo) lines.push(`Repository: ${repo}`)
        if (sender) lines.push(`Sender: ${sender}`)

        // Push
        if (body.ref) lines.push(`Ref: ${body.ref}`)
        if (body.commits && Array.isArray(body.commits)) {
          for (const c of (body.commits as any[]).slice(0, 3)) {
            lines.push(`  - ${c.message?.split("\n")[0] || ""} (${c.author?.name || ""})`)
          }
        }

        // PR
        const pr = body.pull_request as any
        if (pr) {
          lines.push(`PR #${pr.number}: ${pr.title}`)
          lines.push(`Action: ${body.action}`)
          lines.push(`Branch: ${pr.head?.ref} -> ${pr.base?.ref}`)
        }

        // Issue
        const issue = body.issue as any
        if (issue) {
          lines.push(`Issue #${issue.number}: ${issue.title}`)
          lines.push(`Action: ${body.action}`)
        }
        break
      }

      case "stripe": {
        const type = body.type as string || "event"
        const data = (body.data as any)?.object || {}

        lines.push(`Event: ${type}`)
        if (data.amount) lines.push(`Amount: ${(data.amount / 100).toFixed(2)} ${data.currency?.toUpperCase() || ""}`)
        if (data.customer_email) lines.push(`Customer: ${data.customer_email}`)
        if (data.description) lines.push(`Description: ${data.description}`)
        if (data.status) lines.push(`Status: ${data.status}`)
        break
      }

      case "sentry": {
        const resource = headers["sentry-hook-resource"] as string || "event"
        lines.push(`Resource: ${resource}`)

        const data = body.data as any || body
        if (data.error?.title) lines.push(`Error: ${data.error.title}`)
        if (data.error?.culprit) lines.push(`Culprit: ${data.error.culprit}`)
        if (data.error?.metadata?.value) lines.push(`Message: ${data.error.metadata.value}`)
        if (body.url) lines.push(`URL: ${body.url}`)
        break
      }

      default:
        lines.push(`Headers: ${JSON.stringify(Object.keys(headers).filter(k => k.startsWith("x-")).slice(0, 5))}`)
        lines.push(`Payload keys: ${Object.keys(body).slice(0, 10).join(", ")}`)
        // Include raw body summary for unknown sources
        const raw = JSON.stringify(body).slice(0, 500)
        lines.push(`Body: ${raw}`)
    }

    return lines.join("\n")
  }

  private async readBody(req: IncomingMessage): Promise<{ raw: string; parsed: Record<string, unknown> }> {
    return new Promise((resolve) => {
      let body = ""
      req.on("data", (chunk: Buffer) => (body += chunk.toString()))
      req.on("end", () => {
        let parsed: Record<string, unknown>
        try {
          parsed = body ? JSON.parse(body) : {}
        } catch {
          parsed = { raw: body }
        }
        resolve({ raw: body, parsed })
      })
      req.on("error", () => resolve({ raw: "", parsed: {} }))
    })
  }

  /**
   * Validate the inbound webhook signature against the configured secret
   * for this (source, agentId). Returns a human-readable error string when
   * the request must be rejected, or null when the request is allowed
   * through.
   *
   * Per source:
   *  - github: HMAC-SHA256 over the raw body, compared against
   *    `X-Hub-Signature-256: sha256=<hex>`.
   *  - gitlab: simple equality of `X-Gitlab-Token` against the secret.
   *  - stripe: HMAC-SHA256 over `<timestamp>.<body>`, parsed from the
   *    `Stripe-Signature: t=<ts>,v1=<sig>[,v0=...]` header.
   *  - everything else: require `X-Webhook-Secret` to equal the secret.
   *
   * If no `secretEnv` is configured for the matching webhook entry, we let
   * the request through. (Configuring a secret = opt-in to enforcement.)
   */
  private validateSignature(
    headers: Record<string, string | string[] | undefined>,
    raw: string,
    source: string,
    agentId: string,
  ): string | null {
    const entry = this.webhookEntries.find(
      w => w.enabled && w.agentId === agentId && w.source === source,
    )
    if (!entry?.secretEnv) return null
    const secret = process.env[entry.secretEnv]
    if (!secret) {
      return `webhook entry "${entry.id}" expects env ${entry.secretEnv} but it is unset`
    }
    const headerStr = (key: string): string | undefined => {
      const v = headers[key.toLowerCase()]
      return Array.isArray(v) ? v[0] : v
    }

    if (source === "github") {
      const sig = headerStr("x-hub-signature-256")
      if (!sig) return "missing X-Hub-Signature-256"
      const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex")
      return safeEqualOrReject(expected, sig)
    }
    if (source === "gitlab") {
      const tok = headerStr("x-gitlab-token")
      if (!tok) return "missing X-Gitlab-Token"
      return safeEqualOrReject(secret, tok)
    }
    if (source === "stripe") {
      const sigHeader = headerStr("stripe-signature")
      if (!sigHeader) return "missing Stripe-Signature"
      const parts = Object.fromEntries(
        sigHeader.split(",").map(p => p.split("=")) as [string, string][],
      )
      if (!parts.t || !parts.v1) return "malformed Stripe-Signature"
      const expected = createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex")
      return safeEqualOrReject(expected, parts.v1)
    }
    // Generic / discord / slack / sentry / custom: a plain shared secret
    // header is the simplest contract. Operators of these can override at
    // their proxy if they need richer schemes.
    const generic = headerStr("x-webhook-secret")
    if (!generic) return "missing X-Webhook-Secret"
    return safeEqualOrReject(secret, generic)
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(data, null, 2))
  }
}

/** Constant-time compare of two hex/text strings of (potentially) equal
 *  length. Returns null on match, a "signature mismatch" error string
 *  otherwise. Different lengths fail without leaking the expected length. */
function safeEqualOrReject(expected: string, actual: string): string | null {
  if (expected.length !== actual.length) return "signature mismatch"
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return timingSafeEqual(a, b) ? null : "signature mismatch"
}
