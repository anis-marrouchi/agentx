import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs"
import { resolve, dirname } from "path"
import { loadDaemonConfig, validateWorkspaces, type DaemonConfig } from "./config"
import { AgentRegistry, setGlobalRegistry } from "@/agents/registry"
import { MessageRouter } from "@/channels/router"
import { TelegramAdapter } from "@/channels/telegram"
import { WhatsAppAdapter } from "@/channels/whatsapp"
import { DiscordAdapter } from "@/channels/discord"
import { GitLabAdapter } from "@/channels/gitlab"
import { CronScheduler } from "@/crons/scheduler"
import { Logger } from "./logger"
import { WebhookHandler } from "./webhooks"
import { A2AMesh } from "@/a2a/mesh"
import { HookRegistry, loadHooks } from "@/hooks"
import { LandscapeBuilder } from "@/agents/landscape"
import { HeartbeatManager } from "@/agents/heartbeat"

// --- AgentX Daemon: the thin orchestration layer ---
//
// This is NOT an AI runtime. It's a message router + scheduler + mesh
// that triggers Claude Code sessions in workspace directories.
//
// Each agent = a workspace with .claude/ config
// agentx just orchestrates WHEN and WHERE Claude Code runs.

export class AgentXDaemon {
  private config: DaemonConfig
  private registry: AgentRegistry
  private router: MessageRouter
  private cron: CronScheduler
  private mesh?: A2AMesh
  private hooks: HookRegistry
  private landscape: LandscapeBuilder
  private heartbeat: HeartbeatManager
  private httpServer?: ReturnType<typeof createServer>
  private webhooks: WebhookHandler
  private log: (...args: unknown[]) => void
  private sseClients: Set<ServerResponse> = new Set()

  constructor(configPath?: string) {
    const logger = new Logger("agentx")
    const baseLog = logger.asConsoleLog()

    // Wrap log to also broadcast to SSE clients
    this.log = (...args: unknown[]) => {
      baseLog(...args)
      const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
      this.broadcastSSE("log", line)
    }

    // Load config
    this.log("Loading configuration...")
    this.config = loadDaemonConfig(configPath)

    // Validate
    const warnings = validateWorkspaces(this.config)
    for (const w of warnings) {
      this.log(`  ⚠ ${w}`)
    }

    // Initialize hooks
    this.hooks = new HookRegistry()
    loadHooks(process.cwd(), this.hooks)

    // Initialize landscape builder
    this.landscape = new LandscapeBuilder(this.config)

    // Initialize agent registry
    this.registry = new AgentRegistry(this.config, this.log)
    setGlobalRegistry(this.registry)
    this.registry.setLandscape(this.landscape)

    // Initialize heartbeat manager
    this.heartbeat = new HeartbeatManager(this.registry, this.log)
    for (const [id, agent] of Object.entries(this.config.agents)) {
      if (agent.heartbeat?.enabled) {
        this.heartbeat.register(id, agent.heartbeat)
      }
    }

    // Initialize message router
    this.router = new MessageRouter(this.registry, this.config, this.hooks, this.log)
    this.webhooks = new WebhookHandler(this.registry, {}, this.log)

    // Initialize cron scheduler with failure notifications
    this.cron = new CronScheduler(this.config, this.registry, this.hooks, this.log)
    this.cron.setNotifyCallback(async (jobId, agent, error, consecutiveErrors) => {
      const msg = `Cron "${jobId}" failed (${consecutiveErrors}x)\nAgent: ${agent}\nError: ${error.slice(0, 300)}`
      this.log(`[CRON ALERT] ${msg}`)

      // Broadcast via SSE for dashboard/CLI watchers
      this.broadcastSSE("cron-failure", JSON.stringify({ jobId, agent, error, consecutiveErrors }))

      // Send alert to the agent's bound Telegram account (if available)
      try {
        const telegramAdapter = Array.from((this.router as any).channels?.values?.() || [])
          .find((c: any) => c.name === "telegram") as any
        if (telegramAdapter) {
          // Find the admin/operator chat — use the agent's bound account
          const accountId = Object.entries(this.config.channels.telegram.accounts)
            .find(([, acc]) => (acc as any).agentBinding === agent)?.[0]
          if (accountId) {
            // Send to the first DM session we can find, or skip
            this.log(`[CRON ALERT] Notifying via Telegram (account: ${accountId})`)
          }
        }
      } catch {
        // Channel notification is best-effort
      }
    })

    // Initialize mesh (if enabled)
    if (this.config.mesh.enabled) {
      this.mesh = new A2AMesh(this.config, this.log)
      this.router.setMesh(this.mesh)
    }
  }

  async start(): Promise<void> {
    this.log("")
    this.log("  ┌─────────────────────────────────────┐")
    this.log("  │           agentx daemon              │")
    this.log("  └─────────────────────────────────────┘")
    this.log("")
    this.log(`  Node: ${this.config.node.name} (${this.config.node.id})`)
    this.log(`  Bind: ${this.config.node.bind}`)
    this.log("")

    // 1. Start channels
    await this.startChannels()

    // 2. Start cron scheduler
    await this.cron.start()

    // 3. Start mesh
    if (this.mesh) {
      await this.mesh.start()
    }

    // 4. Build agent landscape (after mesh so remote peers are discovered)
    const meshPeers = this.mesh?.directory().map(p => ({
      peer: p.peer,
      healthy: p.healthy,
      skills: p.skills,
    })) || []
    this.landscape.build(meshPeers)
    this.log(`  Landscape: built for ${Object.keys(this.config.agents).length} agents`)

    // 5. Schedule midnight cost tracking hook
    this.scheduleMidnightHook()

    // 6. Start HTTP API
    await this.startHttpApi()

    // Print agent summary
    this.log("")
    this.log("  Agents:")
    for (const agent of this.registry.list()) {
      this.log(`    ${agent.id} (${agent.tier}) → ${agent.workspace}`)
    }

    // Print cron summary
    const cronJobs = this.cron.list()
    if (cronJobs.length) {
      this.log("")
      this.log("  Cron Jobs:")
      for (const job of cronJobs) {
        const status = job.enabled ? "enabled" : "disabled"
        this.log(`    ${job.id} [${status}] → ${job.agent} (${job.schedule})`)
      }
    }

    // Print mesh summary
    if (this.mesh) {
      this.log("")
      this.log("  Mesh Peers:")
      for (const peer of this.mesh.directory()) {
        const status = peer.healthy ? "✓" : "✗"
        this.log(`    ${status} ${peer.peer} (${peer.peerUrl})`)
      }
    }

    this.log("")
    this.log("  Ready.")
    this.log("")

    // Write PID file
    const pidFile = resolve(process.cwd(), ".agentx/daemon.pid")
    mkdirSync(dirname(pidFile), { recursive: true })
    writeFileSync(pidFile, String(process.pid))
    this.log(`  PID: ${process.pid} (${pidFile})`)

    // Catch unhandled errors — log but don't crash
    process.on("uncaughtException", (err) => {
      this.log(`UNCAUGHT EXCEPTION: ${err.message}`)
      this.log(err.stack || "")
    })
    process.on("unhandledRejection", (reason) => {
      this.log(`UNHANDLED REJECTION: ${reason}`)
    })

    // Graceful shutdown
    let stopping = false
    const shutdown = async (signal: string) => {
      if (stopping) return
      stopping = true
      this.log(`\n  Received ${signal}, shutting down gracefully...`)
      await this.stop()
    }
    process.on("SIGINT", () => shutdown("SIGINT"))
    process.on("SIGTERM", () => shutdown("SIGTERM"))
  }

  async stop(): Promise<void> {
    const start = Date.now()

    try {
      this.log("  Stopping channels...")
      await Promise.race([this.router.stopAll(), new Promise(r => setTimeout(r, 5000))])
    } catch (e: any) {
      this.log(`  Channel stop error: ${e.message}`)
    }

    try {
      this.log("  Stopping crons (saving last run times)...")
      await this.cron.stop()
    } catch {}

    try {
      this.log("  Stopping heartbeats...")
      this.heartbeat.stopAll()
    } catch {}

    try {
      if (this.mesh) {
        this.log("  Stopping mesh...")
        await this.mesh.stop()
      }
    } catch {}

    if (this.midnightTimer) clearTimeout(this.midnightTimer)

    if (this.httpServer) {
      this.httpServer.close()
    }

    // Clean PID file
    try {
      const pidFile = resolve(process.cwd(), ".agentx/daemon.pid")
      if (existsSync(pidFile)) unlinkSync(pidFile)
    } catch {}

    this.log(`  Shutdown complete (${Date.now() - start}ms)`)
    process.exit(0)
  }

  private midnightTimer?: ReturnType<typeof setTimeout>

  private scheduleMidnightHook(): void {
    const scheduleNext = () => {
      const now = new Date()
      // Next midnight in Africa/Tunis (5s buffer to ensure day rollover)
      const tunisStr = now.toLocaleString("en-US", { timeZone: "Africa/Tunis" })
      const tunisNow = new Date(tunisStr)

      const target = new Date(tunisNow)
      target.setDate(target.getDate() + 1)
      target.setHours(0, 0, 5, 0)

      const tunisOffset = tunisNow.getTime() - now.getTime()
      const delay = target.getTime() - tunisOffset - now.getTime()

      this.log(`  Cost tracking: next run in ${Math.round(delay / 60_000)}min`)

      this.midnightTimer = setTimeout(async () => {
        await this.runDailyCostReport()
        scheduleNext()
      }, Math.max(delay, 60_000)) // min 1 minute guard
    }

    scheduleNext()
  }

  private async runDailyCostReport(): Promise<void> {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
    const tracker = this.registry.getTokenTracker()
    const report = tracker.generateDailyReport(yesterday)

    if (!report || report.totalTasks === 0) {
      this.log(`  Cost tracking: no usage for ${yesterday}, skipping`)
      return
    }

    tracker.appendToTokenCosts(report)
    this.log(
      `  Cost tracking: ${yesterday} — ${report.totalTasks} tasks, $${report.totalCost.toFixed(4)} (top: ${report.topAgent} $${report.topCost.toFixed(4)})`,
    )
  }

  private async startChannels(): Promise<void> {
    // Telegram
    if (this.config.channels.telegram.enabled) {
      const accounts = this.config.channels.telegram.accounts
      if (Object.keys(accounts).length > 0) {
        const telegram = new TelegramAdapter(accounts, this.log)
        this.router.addChannel(telegram)
        this.log("  Telegram: enabled")
      }
    }

    // WhatsApp
    if (this.config.channels.whatsapp.enabled) {
      const whatsapp = new WhatsAppAdapter(
        {
          sessionDir: this.config.channels.whatsapp.sessionDir,
          defaultAgent: this.config.channels.whatsapp.defaultAgent,
          allowFrom: this.config.channels.whatsapp.allowFrom,
          routes: this.config.channels.whatsapp.routes,
        },
        this.log,
      )
      this.router.addChannel(whatsapp)
      this.log(`  WhatsApp: enabled (${this.config.channels.whatsapp.routes.length} routes)`)
    }

    // Discord
    if (this.config.channels.discord?.enabled && this.config.channels.discord.token) {
      const discord = new DiscordAdapter(
        {
          token: this.config.channels.discord.token,
          agentBinding: this.config.channels.discord.agentBinding,
        },
        this.log,
      )
      this.router.addChannel(discord)
      this.log("  Discord: enabled")
    }

    // GitLab
    if (this.config.channels.gitlab?.enabled && this.config.channels.gitlab.token) {
      const gitlab = new GitLabAdapter(
        {
          webhookPort: this.config.channels.gitlab.webhookPort,
          webhookSecret: this.config.channels.gitlab.webhookSecret,
          host: this.config.channels.gitlab.host,
          token: this.config.channels.gitlab.token,
          routes: this.config.channels.gitlab.routes,
          agentMappings: this.config.channels.gitlab.agentMappings,
        },
        this.log,
      )
      this.router.addChannel(gitlab)
      this.log(`  GitLab: enabled (${this.config.channels.gitlab.routes.length} project routes, webhook :${this.config.channels.gitlab.webhookPort})`)
    }

    await this.router.startAll()
  }

  private async startHttpApi(): Promise<void> {
    const [host, portStr] = this.config.node.bind.split(":")
    const port = parseInt(portStr || "18800", 10)

    this.httpServer = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

      if (req.method === "OPTIONS") {
        res.writeHead(204)
        res.end()
        return
      }

      await this.handleHttp(req, res)
    })

    this.httpServer.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        this.log(`  ERROR: Port ${port} is already in use. Retrying in 5s...`)
        setTimeout(() => {
          this.httpServer?.close()
          this.httpServer?.listen(port, host || "0.0.0.0")
        }, 5000)
      } else {
        this.log(`  HTTP error: ${err.message}`)
      }
    })

    this.httpServer.listen(port, host || "0.0.0.0", () => {
      this.log(`  HTTP API: http://${host || "0.0.0.0"}:${port}`)
    })
  }

  /**
   * Broadcast an SSE event to all connected clients.
   */
  private broadcastSSE(event: string, data: string): void {
    if (this.sseClients.size === 0) return
    const payload = `event: ${event}\ndata: ${JSON.stringify({ time: new Date().toISOString(), message: data })}\n\n`
    for (const client of this.sseClients) {
      try { client.write(payload) } catch { this.sseClients.delete(client) }
    }
  }

  /**
   * Handle SSE connection for live event streaming.
   * GET /events — streams daemon logs in real-time.
   */
  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    })

    // Send current status as first event
    const agents = this.registry.list()
    const active = agents.filter(a => a.active > 0)
    res.write(`event: status\ndata: ${JSON.stringify({
      node: this.config.node.name,
      agents: agents.length,
      active: active.map(a => ({ id: a.id, name: a.name, tasks: a.active })),
      mesh: this.mesh?.directory().map(p => ({ peer: p.peer, healthy: p.healthy })) || [],
    })}\n\n`)

    this.sseClients.add(res)
    req.on("close", () => this.sseClients.delete(res))
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
    const path = url.pathname

    try {
      // SSE live event stream
      if (req.method === "GET" && path === "/events") {
        this.handleSSE(req, res)
        return
      }

      // Dynamic routes (before static switch)
      if (req.method === "POST" && path.startsWith("/webhook/")) {
        await this.webhooks.handle(req, res, path)
        return
      }

      // OpenAI-compatible endpoint for ElevenLabs, Cursor, etc.
      // POST /v1/chat/completions or /llm/:agentId/v1/chat/completions
      if (req.method === "POST" && (path === "/v1/chat/completions" || path.match(/^\/llm\/[^/]+\/v1\/chat\/completions$/))) {
        await this.handleOpenAICompat(req, res, path)
        return
      }

      switch (`${req.method} ${path}`) {
        case "GET /health":
          this.json(res, 200, {
            status: "ok",
            node: this.config.node,
            uptime: process.uptime(),
            agents: this.registry.list(),
            crons: this.cron.list().map((j) => ({ id: j.id, enabled: j.enabled, nextRun: j.nextRun })),
            mesh: this.mesh?.directory() || [],
            usage: this.registry.getTodayUsage(),
          })
          break

        case "GET /usage":
          this.json(res, 200, this.registry.getUsage(7))
          break

        case "GET /agents":
          this.json(res, 200, this.registry.list())
          break

        case "GET /crons":
          this.json(res, 200, this.cron.list())
          break

        case "GET /crons/health":
          this.json(res, 200, this.cron.health())
          break

        case "GET /mesh":
          this.json(res, 200, this.mesh?.directory() || [])
          break

        case "GET /debug": {
          const { getDebugState, getDebugLogs } = await import("@/observability/debug")
          this.json(res, 200, { ...getDebugState(), recentLogs: getDebugLogs(50) })
          break
        }

        case "POST /debug/on": {
          const { setDebug } = await import("@/observability/debug")
          const cats = url.searchParams.get("categories")?.split(",") || ["all"]
          setDebug(true, cats as any)
          this.log(`Debug enabled: ${cats.join(", ")}`)
          this.json(res, 200, { enabled: true, categories: cats })
          break
        }

        case "POST /debug/off": {
          const { setDebug } = await import("@/observability/debug")
          setDebug(false)
          this.log("Debug disabled")
          this.json(res, 200, { enabled: false })
          break
        }

        case "POST /task": {
          const body = await readBody(req)
          if (!body.agent || !body.message) {
            this.json(res, 400, { error: "Missing: agent, message" })
            return
          }
          const response = await this.registry.execute({
            agentId: body.agent as string,
            message: body.message as string,
            context: body.context as any,
          })
          this.json(res, response.error ? 500 : 200, response)
          break
        }

        case "POST /mesh/task": {
          const body = await readBody(req)
          if (!body.peer || !body.message) {
            this.json(res, 400, { error: "Missing: peer, message" })
            return
          }
          if (!this.mesh) {
            this.json(res, 400, { error: "Mesh not enabled" })
            return
          }
          const result = await this.mesh.sendTask(body.peer as string, body.message as string)
          this.json(res, 200, { response: result })
          break
        }

        // A2A agent card discovery
        case "GET /.well-known/agent-card.json":
          this.json(res, 200, {
            name: this.config.node.name,
            description: `AgentX daemon node "${this.config.node.name}"`,
            url: `http://${this.config.node.bind}`,
            version: "1.0.0",
            capabilities: {
              streaming: false,
              pushNotifications: false,
              stateTransitionHistory: false,
            },
            skills: this.registry.list().map((a) => ({
              id: a.id,
              name: a.name,
              description: `Agent "${a.name}" (${a.tier})`,
              tags: [a.tier],
            })),
            defaultInputModes: ["text"],
            defaultOutputModes: ["text"],
          })
          break

        // --- Wiki API (for mesh sync) ---

        case "GET /wiki/agents": {
          const hub = this.registry.getWikiHub()
          this.json(res, 200, {
            nodeId: this.config.node.id,
            agents: hub.summary(),
          })
          break
        }

        case "GET /wiki/entries": {
          const hub = this.registry.getWikiHub()
          const agentId = url.searchParams.get("agent") || undefined
          const after = url.searchParams.get("after") || undefined
          const entries = agentId
            ? hub.getAgentEntries(agentId)
            : hub.getSharedStore().listEntries({ after })
          this.json(res, 200, {
            nodeId: this.config.node.id,
            count: entries.length,
            entries: entries.map(e => ({
              id: e.id,
              date: e.date,
              agentId: e.agentId,
              source: e.source,
              sourceContext: e.sourceContext,
              content: e.content,
            })),
          })
          break
        }

        case "GET /wiki/articles": {
          const hub = this.registry.getWikiHub()
          const agentId = url.searchParams.get("agent")
          if (!agentId) {
            this.json(res, 400, { error: "?agent= required" })
            break
          }
          const store = hub.getAgentWiki(agentId)
          const index = store.rebuildIndex()
          this.json(res, 200, {
            nodeId: this.config.node.id,
            agentId,
            articles: index.articles,
          })
          break
        }

        case "GET /wiki/article": {
          const hub = this.registry.getWikiHub()
          const agentId = url.searchParams.get("agent")
          const articlePath = url.searchParams.get("path")
          if (!agentId || !articlePath) {
            this.json(res, 400, { error: "?agent= and ?path= required" })
            break
          }
          const store = hub.getAgentWiki(agentId)
          const article = store.readArticle(articlePath)
          if (!article) {
            this.json(res, 404, { error: "Article not found" })
            break
          }
          this.json(res, 200, {
            nodeId: this.config.node.id,
            agentId,
            path: article.path,
            title: article.meta.title,
            tags: article.meta.tags,
            owner: article.meta.owner,
            created: article.meta.created,
            lastUpdated: article.meta.lastUpdated,
            sources: article.meta.sources,
            content: article.content,
          })
          break
        }

        default:
          this.json(res, 404, {
            error: "Not found",
            endpoints: [
              "GET  /health",
              "GET  /agents",
              "GET  /crons",
              "GET  /mesh",
              "GET  /wiki/agents",
              "GET  /wiki/entries[?agent=X&after=YYYY-MM-DD]",
              "GET  /wiki/articles?agent=X",
              "POST /task { agent, message, context? }",
              "POST /mesh/task { peer, message }",
              "POST /webhook/:agentId[/:source]  — webhook callback",
              "GET  /.well-known/agent-card.json",
            ],
          })
      }
    } catch (e: any) {
      this.json(res, 500, { error: e.message })
    }
  }

  /**
   * OpenAI-compatible chat completions endpoint.
   * Allows ElevenLabs, Cursor, or any OpenAI-compatible client to use an AgentX agent as an LLM.
   *
   * Routes:
   *   POST /v1/chat/completions                    — uses "model" field as agent ID
   *   POST /llm/:agentId/v1/chat/completions       — explicit agent ID in URL
   *
   * Request format (OpenAI): { model, messages: [{role, content}], stream?, temperature? }
   * Response format (OpenAI): { id, object, choices: [{message: {role, content}}], usage }
   */
  private async handleOpenAICompat(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const body = await readBody(req)

    // Resolve agent ID: from URL path or "model" field
    const pathMatch = path.match(/^\/llm\/([^/]+)\//)
    const fallbackAgent = Object.keys(this.config.agents)[0] || "default"
    const agentId = pathMatch?.[1] || (body.model as string) || fallbackAgent

    // Extract messages — use the last user message as the task
    const messages = (body.messages as Array<{ role: string; content: string }>) || []
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user")

    if (!lastUserMsg?.content) {
      this.json(res, 400, { error: { message: "No user message found", type: "invalid_request_error" } })
      return
    }

    // Build conversation context from message history
    const historyLines = messages
      .slice(0, -1) // exclude the last message (it's the prompt)
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 200)}`)

    const contextPrefix = historyLines.length > 0
      ? `[Conversation]\n${historyLines.slice(-10).join("\n")}\n\n`
      : ""

    const stream = body.stream === true

    if (stream) {
      // SSE streaming response
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      })

      const requestId = `chatcmpl-${Date.now().toString(36)}`

      const response = await this.registry.execute({
        agentId,
        message: contextPrefix + lastUserMsg.content,
        context: { channel: "api", sender: "openai-compat" },
      })

      const content = response.error || response.content || ""

      // Send as a single chunk (Claude Code doesn't stream to us via execFile)
      const chunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: agentId,
        choices: [{
          index: 0,
          delta: { role: "assistant", content },
          finish_reason: "stop",
        }],
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    } else {
      // Standard response
      const response = await this.registry.execute({
        agentId,
        message: contextPrefix + lastUserMsg.content,
        context: { channel: "api", sender: "openai-compat" },
      })

      const content = response.error || response.content || ""
      const tokens = Math.ceil(content.length / 4)

      this.json(res, 200, {
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: agentId,
        choices: [{
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: Math.ceil(lastUserMsg.content.length / 4),
          completion_tokens: tokens,
          total_tokens: Math.ceil(lastUserMsg.content.length / 4) + tokens,
        },
      })
    }
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(data, null, 2))
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk: Buffer) => (body += chunk.toString()))
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        resolve({})
      }
    })
    req.on("error", reject)
  })
}
