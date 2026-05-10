import type { IncomingMessage, ServerResponse } from "http"
import { createHmac, timingSafeEqual } from "crypto"
import type { AgentRegistry } from "@/agents/registry"
import type { A2AMesh } from "@/a2a/mesh"
import type { DaemonConfig } from "./config"
import type { WorkflowDispatcher } from "@/workflows"
import type { HookRegistry } from "@/hooks"
import type { HookEvent } from "@/hooks/types"

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
  private workflowDispatcher?: WorkflowDispatcher
  private hooks?: HookRegistry

  constructor(
    registry: AgentRegistry,
    config: WebhookConfig = {},
    log: (...args: unknown[]) => void = console.error.bind(console, "[webhook]"),
    mesh?: A2AMesh,
    webhookEntries: DaemonConfig["webhooks"] = [],
    hooks?: HookRegistry,
  ) {
    this.registry = registry
    this.config = config
    this.log = log
    this.mesh = mesh
    this.webhookEntries = webhookEntries
    this.hooks = hooks
  }

  /**
   * Map a webhook source + eventType to an `on:*` hook event name. Used to
   * fire bus events that workflow `trigger.hook` subscribers consume.
   * Returns null when no hook event is mapped (e.g. unknown source).
   */
  private hookEventFor(source: string, eventType: string | undefined): HookEvent | null {
    if (source === "stripe") return "on:stripe-event"
    if (source === "sentry") return "on:sentry-issue"
    if (source === "vercel") return "on:vercel-deployment"
    if (source === "hubspot") return "on:hubspot-event"
    if (source === "odoo") return "on:odoo-event"
    if (source === "github") {
      // GitHub eventType is "<x-github-event>.<action>" or just "<event>".
      const head = (eventType ?? "").split(".")[0]
      if (head === "issues" || head === "issue_comment") return "on:github-issue"
      if (head === "pull_request" || head === "pull_request_review") return "on:github-pr"
      if (head === "push") return "on:github-push"
      return null
    }
    // gitlab events are emitted by src/channels/gitlab.ts already; don't
    // double-fire from here.
    return null
  }

  /**
   * Best-effort fire of a hook event for the given webhook. Errors are
   * caught and logged — never block the inbound webhook on subscriber
   * failures.
   */
  private async fireHookSafe(
    source: string,
    eventType: string | undefined,
    agentId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event = this.hookEventFor(source, eventType)
    if (!event || !this.hooks) return
    if (!this.hooks.has(event)) return
    try {
      await this.hooks.execute(event, {
        event,
        source,
        eventType,
        agentId,
        payload,
      } as any)
    } catch (e: any) {
      this.log(`${event} hook error (non-fatal): ${e?.message ?? e}`)
    }
  }

  /** Wired by the daemon after the workflow subsystem boots. When set,
   *  webhook entries with a `triggers` map can dispatch a workflow per
   *  inbound event-type instead of running the bound agent directly. */
  setWorkflowDispatcher(d: WorkflowDispatcher): void {
    this.workflowDispatcher = d
  }

  /** Hot-reload the webhook entry table. Called by the daemon's reload
   *  handler when `webhooks[]` changes in agentx.json — adding a route,
   *  rotating a secretEnv, flipping an entry from local to mesh-routed,
   *  or editing a triggers map. Phase 4: closes the recurring complaint
   *  that route changes require a full daemon restart. */
  setWebhookEntries(entries: DaemonConfig["webhooks"]): void {
    this.webhookEntries = entries
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
    // Debug: dump source-relevant headers so we can see what providers
    // actually send when signature verification fails. Gated by env var so
    // production logs stay clean.
    if (process.env.AGENTX_WEBHOOK_DEBUG_HEADERS === "1") {
      const interesting: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.startsWith("x-hubspot") || k.startsWith("x-hub") || k.startsWith("x-github") ||
            k.startsWith("x-gitlab") || k.startsWith("stripe") || k.startsWith("sentry") ||
            k.startsWith("x-vercel") || k.startsWith("x-odoo") || k.startsWith("x-webhook") ||
            k === "user-agent" || k === "content-type" || k === "host" ||
          k === "x-forwarded-host" || k === "x-forwarded-proto" ||
          k === "x-forwarded-for") {
          interesting[k] = v
        }
      }
      this.log(`Webhook [${source}] reqUrl=${(req as any).url} headers: ${JSON.stringify(interesting)}`)
    }
    const sigError = this.validateSignature(req.headers, raw, source, agentId, req.url)
    if (sigError) {
      this.log(`Webhook [${source}] -> ${agentId}: REJECTED (${sigError})`)
      this.sendJson(res, 401, { error: sigError })
      return
    }

    // Parse the webhook payload into a human-readable message
    const summary = this.buildSummary(source, parsed, req.headers)

    this.log(`Webhook [${source}] -> ${agentId}: ${summary.slice(0, 100)}`)

    // Phase 3: per-event-type workflow routing. Each registered webhook
    // entry can map specific event-types to workflow ids; on match we
    // dispatch the workflow instead of running the bound agent directly.
    // Falls through to the existing agent path if nothing matches and no
    // defaultWorkflow is set — backward-compatible.
    const eventType = this.extractEventType(source, parsed, req.headers)
    const triggerEntry = this.webhookEntries.find(
      w => w.enabled && w.agentId === agentId && w.source === source,
    )
    const workflowId =
      (eventType && triggerEntry?.triggers?.[eventType]) ||
      triggerEntry?.defaultWorkflow ||
      null
    // Fire the on:* hook event so workflows with `trigger.hook` can
    // subscribe (parallel to the per-event-type workflow routing below).
    // Best-effort, never blocks the inbound webhook.
    await this.fireHookSafe(source, eventType, agentId, parsed)

    if (workflowId && this.workflowDispatcher) {
      try {
        const result = await this.workflowDispatcher.dispatchWorkflow({
          workflowId,
          entityRef: { kind: "webhook", id: `${source}:${agentId}:${eventType ?? "—"}:${Date.now()}` } as any,
          event: { kind: "webhook", source, eventType, payload: parsed } as any,
          trigger: { source },
        })
        this.log(
          `Webhook [${source}/${eventType ?? "—"}] -> workflow=${workflowId} (claimed=${result.claimed})`,
        )
        this.sendJson(res, 202, {
          ok: true,
          agent: agentId,
          source,
          eventType,
          workflow: workflowId,
          claimed: result.claimed,
        })
        return
      } catch (e: any) {
        this.log(`Workflow dispatch failed [${source}/${eventType}/${workflowId}]: ${e.message}`)
        // Fall through to agent path on error so we don't drop the event entirely.
      }
    }

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
      // Forward the same context shape the local execution path would use,
      // so the receiving daemon's registry.execute keys the session by
      // `webhook:${source}` instead of falling back to api/default and
      // losing the source attribution.
      this.mesh.sendTask(meshEntry.node, summary, agentId, {
        context: {
          channel: `webhook:${source}`,
          sender: `webhook:${source}`,
        },
      }).then(
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
   * Extract a canonical event-type string from inbound headers + body.
   * Used by the per-event-type trigger map. Format conventions:
   *   - GitHub: `<X-GitHub-Event>.<body.action>` when action exists,
   *             else just `<X-GitHub-Event>` (e.g. "push", "ping").
   *   - GitLab: `<X-Gitlab-Event>` (already includes a "Hook" suffix —
   *             "Push Hook", "Note Hook", "Merge Request Hook").
   *   - Stripe: `<body.type>` (e.g. "invoice.paid").
   *   - Sentry: `<Sentry-Hook-Resource>` (e.g. "issue", "event_alert").
   *   - Anything else: returns null and the dispatcher falls back to
   *     `defaultWorkflow`.
   */
  private extractEventType(
    source: string,
    body: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
  ): string | undefined {
    const header = (k: string): string | undefined => {
      const v = headers[k.toLowerCase()]
      return Array.isArray(v) ? v[0] : v
    }
    if (source === "github") {
      const evt = header("x-github-event")
      if (!evt) return undefined
      const action = typeof body.action === "string" ? body.action : undefined
      return action ? `${evt}.${action}` : evt
    }
    if (source === "gitlab") {
      return header("x-gitlab-event") || (typeof body.object_kind === "string" ? body.object_kind : undefined)
    }
    if (source === "stripe") {
      return typeof body.type === "string" ? body.type : undefined
    }
    if (source === "sentry") {
      return header("sentry-hook-resource")
    }
    if (source === "hubspot") {
      // HubSpot v3 webhooks send an ARRAY of events as the top-level JSON
      // body. JSON.parse keeps it as an array; we type it loosely here. Pull
      // the first event's `subscriptionType` (e.g. "contact.creation",
      // "deal.propertyChange") — per-event-type routing keys on this value.
      // Older subscriptions ship a singleton event object; handle both.
      if (Array.isArray(body) && body.length > 0) {
        const first = (body as unknown[])[0] as { subscriptionType?: unknown } | undefined
        if (first && typeof first.subscriptionType === "string") return first.subscriptionType
      }
      if (typeof (body as { subscriptionType?: unknown }).subscriptionType === "string") {
        return (body as { subscriptionType: string }).subscriptionType
      }
      return undefined
    }
    if (source === "odoo") {
      // Common Odoo webhook payload shapes. Order matters — `event` is the
      // most explicit when present (paid Odoo Apps connectors), otherwise
      // fall back to `model` + `action` (standard `webhook`/`automated_actions`
      // modules), then `model` alone, then `subscriptionType` for Odoo SaaS.
      if (typeof body.event === "string") return body.event
      if (typeof body.subscriptionType === "string") return body.subscriptionType
      if (typeof body.model === "string") {
        return typeof body.action === "string" ? `${body.model}.${body.action}` : body.model
      }
      return undefined
    }
    return undefined
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
    // HubSpot v3 webhooks always include both signature + timestamp headers
    // and announce themselves via X-HubSpot-Signature-Version: v3.
    if (headers["x-hubspot-signature-v3"] || headers["x-hubspot-signature-version"]) return "hubspot"
    // Odoo doesn't have a universal header across modules; common signals
    // are `x-odoo-database` (set by Odoo Online on outgoing webhooks) or
    // `x-odoo-signature` (HMAC-signing modules). When neither is present,
    // operators should pin the source via /webhook/:agent/odoo URL hint.
    if (headers["x-odoo-database"] || headers["x-odoo-signature"]) return "odoo"
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

      case "hubspot": {
        // HubSpot ships an array of events; surface up to the first 3.
        const arr = Array.isArray(body) ? (body as unknown[]) : null
        const events = arr ? (arr as Array<Record<string, unknown>>) : null
        if (events && events.length) {
          lines.push(`Events: ${events.length}`)
          for (const e of events.slice(0, 3)) {
            const sub = e.subscriptionType ?? "?"
            const oid = e.objectId ?? "?"
            const flag = e.changeFlag ?? e.changeSource ?? ""
            lines.push(`  - ${sub} (object ${oid}${flag ? `, ${flag}` : ""})`)
          }
        } else {
          // Singleton event payload (older HubSpot subscriptions).
          const sub = (body as any).subscriptionType ?? "event"
          const oid = (body as any).objectId ?? "?"
          lines.push(`Event: ${sub} (object ${oid})`)
        }
        const portalId = (events?.[0]?.portalId) ?? (body as any).portalId
        if (portalId != null) lines.push(`Portal: ${portalId}`)
        break
      }

      case "odoo": {
        // Odoo modules emit varying shapes — we surface what's commonly
        // present without assuming any specific connector.
        const event =
          (typeof body.event === "string" && body.event) ||
          (typeof body.subscriptionType === "string" && body.subscriptionType) ||
          (typeof body.model === "string" &&
            (typeof body.action === "string" ? `${body.model}.${body.action}` : body.model)) ||
          "event"
        lines.push(`Event: ${event}`)
        const db = (headers["x-odoo-database"] as string) || (typeof body.database === "string" ? body.database : "")
        if (db) lines.push(`Database: ${db}`)
        const rec = (body.record as any) || body
        if (rec?.id) lines.push(`Record id: ${rec.id}`)
        if (rec?.name) lines.push(`Name: ${String(rec.name).slice(0, 200)}`)
        if (rec?.partner_id?.[1]) lines.push(`Partner: ${rec.partner_id[1]}`)
        if (rec?.email) lines.push(`Email: ${rec.email}`)
        if (rec?.amount_total != null) lines.push(`Amount: ${rec.amount_total}`)
        if (rec?.state) lines.push(`State: ${rec.state}`)
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
    reqUrl?: string,
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
    if (source === "hubspot") {
      // HubSpot v3 signature scheme — base64(HMAC-SHA256(secret, METHOD+URI+body+timestamp))
      // sent in `X-HubSpot-Signature-v3`. Timestamp is in `X-HubSpot-Request-Timestamp`
      // (milliseconds since epoch). HubSpot recommends rejecting webhooks
      // older than 5 minutes to mitigate replay attacks.
      const sig = headerStr("x-hubspot-signature-v3")
      const ts = headerStr("x-hubspot-request-timestamp")
      if (!sig) return "missing X-HubSpot-Signature-v3"
      if (!ts) return "missing X-HubSpot-Request-Timestamp"
      const tsNum = parseInt(ts, 10)
      if (!Number.isFinite(tsNum)) return "malformed X-HubSpot-Request-Timestamp"
      const ageMs = Date.now() - tsNum
      if (ageMs > 5 * 60_000) return `HubSpot webhook is ${Math.floor(ageMs / 1000)}s old (>5min replay window)`
      // HubSpot signs METHOD + URI + body + timestamp. The URI is the FULL
      // public URL the app was configured to deliver to (scheme + host + path).
      // Behind a reverse proxy (Tailscale Funnel, Cloudflare Tunnel, Caddy,
      // nginx) the inbound `req.url` is just the path and `host` is whatever
      // the proxy passed through. Build the URI from the most authoritative
      // signals available, then try several reasonable variants since
      // operators may set up TLS termination differently:
      //   1. https://<x-forwarded-host or host><req.url>      (most common)
      //   2. http://<host><req.url>                            (HTTP-only setups)
      //   3. just <req.url>                                    (path-only signing)
      //   4. legacy x-original-uri / x-forwarded-path fallback
      //   5. empty                                             (very rare)
      const method = "POST"
      const path = reqUrl || (headers["x-original-uri"] as string) || (headers["x-forwarded-path"] as string) || ""
      const fwdHost = headers["x-forwarded-host"] as string | undefined
      const rawHost = headers["host"] as string | undefined
      const fwdProto = (headers["x-forwarded-proto"] as string | undefined) || "https"
      const candidates = new Set<string>()
      if (fwdHost && path) candidates.add(`${fwdProto}://${fwdHost}${path}`)
      if (rawHost && path) candidates.add(`https://${rawHost}${path}`)
      if (rawHost && path) candidates.add(`http://${rawHost}${path}`)
      if (path) candidates.add(path)
      candidates.add("")
      for (const uri of candidates) {
        const expected = createHmac("sha256", secret).update(`${method}${uri}${raw}${ts}`).digest("base64")
        if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          return null
        }
      }
      return `signature mismatch (tried ${candidates.size} URI variants)`
    }
    if (source === "odoo") {
      // Odoo's signing scheme varies by module (`webhook` / `automated_actions`
      // / paid Odoo Apps connectors). Two patterns dominate:
      //   1) HMAC-SHA256 over the raw body, sent in `X-Odoo-Signature`
      //      (hex digest, sometimes prefixed `sha256=`).
      //   2) A shared secret token in `X-Odoo-Webhook-Token` (or the generic
      //      `X-Webhook-Secret` fallback) — common in older / community setups.
      // Accept either; reject only if neither header is present.
      const sig = headerStr("x-odoo-signature")
      if (sig) {
        const expected = createHmac("sha256", secret).update(raw).digest("hex")
        const sigHex = sig.startsWith("sha256=") ? sig.slice("sha256=".length) : sig
        return safeEqualOrReject(expected, sigHex)
      }
      const tok = headerStr("x-odoo-webhook-token") ?? headerStr("x-webhook-secret")
      if (!tok) return "missing X-Odoo-Signature or X-Odoo-Webhook-Token"
      return safeEqualOrReject(secret, tok)
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
