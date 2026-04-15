import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { writeFileSync, existsSync, unlinkSync, mkdirSync, watch, type FSWatcher } from "fs"
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
import { setupAllWorkspaces } from "@/agents/workspace-setup"
import { ServiceMatcher } from "@/services/matcher"
import { BusinessLayer } from "@/business"

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
  private business?: BusinessLayer
  private httpServer?: ReturnType<typeof createServer>
  private webhooks: WebhookHandler
  private log: (...args: unknown[]) => void
  private sseClients: Set<ServerResponse> = new Set()
  private configPath?: string
  private configWatcher?: FSWatcher
  private reloadTimer?: ReturnType<typeof setTimeout>

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
    this.configPath = configPath
    this.config = loadDaemonConfig(configPath)

    // Validate
    const warnings = validateWorkspaces(this.config)
    for (const w of warnings) {
      this.log(`  ⚠ ${w}`)
    }

    // Set up agent workspaces with Claude Code best practices (non-destructive)
    const [, portStr] = this.config.node.bind.split(":")
    setupAllWorkspaces(this.config.agents, portStr || "19900", this.log)

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

    // Initialize service matcher (automated client services)
    if (Object.keys(this.config.services).length > 0) {
      const serviceMatcher = new ServiceMatcher(this.config.services, this.log)
      this.router.setServiceMatcher(serviceMatcher)
    }

    // Initialize cron scheduler with failure notifications
    this.cron = new CronScheduler(this.config, this.registry, this.hooks, this.log)
    this.cron.setNotifyCallback(async (jobId, agent, error, consecutiveErrors) => {
      const msg = `Cron "${jobId}" failed (${consecutiveErrors}x)\nAgent: ${agent}\nError: ${error.slice(0, 300)}`
      this.log(`[CRON ALERT] ${msg}`)
      this.broadcastSSE("cron-failure", JSON.stringify({ jobId, agent, error, consecutiveErrors }))

      // Send to the cron job's configured notify destination (if set)
      const cronDef = this.config.crons[jobId]
      if (cronDef?.notify) {
        try {
          await this.router.sendOutbound({
            channel: cronDef.notify.channel,
            chatId: cronDef.notify.chatId,
            text: `🔴 **Cron "${jobId}" failed** (${consecutiveErrors}x)\n${error.slice(0, 300)}`,
            agentId: agent,
            accountId: cronDef.notify.accountId,
          })
        } catch (e: any) {
          this.log(`[CRON ALERT] notify send failed: ${e.message}`)
        }
      }
    })

    // Initialize mesh (if enabled)
    if (this.config.mesh.enabled) {
      this.mesh = new A2AMesh(this.config, this.log)
      this.router.setMesh(this.mesh)
    }

    // Initialize business layer (if enabled)
    if (this.config.business?.enabled) {
      try {
        this.business = new BusinessLayer(
          this.config.business,
          this.config,
          this.registry,
          this.router,
          this.log,
        )
        this.router.setBusiness(this.business)
      } catch (e: any) {
        this.log(`[business] initialization failed: ${e.message}`)
      }
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

    // 5b. Start business layer day cycle (if configured)
    if (this.business) {
      this.business.start()
      this.log(`  ${this.business.summary()}`)
    }

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

    // Start config file watcher (opt-out via AGENTX_AUTO_RELOAD=false)
    if (process.env.AGENTX_AUTO_RELOAD !== "false") {
      this.startConfigWatcher()
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
      if (this.business) {
        this.log("  Stopping business layer...")
        this.business.stop()
      }
    } catch {}

    try {
      if (this.mesh) {
        this.log("  Stopping mesh...")
        await this.mesh.stop()
      }
    } catch {}

    if (this.midnightTimer) clearTimeout(this.midnightTimer)

    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    if (this.configWatcher) {
      try { this.configWatcher.close() } catch { /* best effort */ }
    }

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

  /**
   * Watch agentx.json for external edits (e.g. `agentx config set ...`) and
   * reload cron jobs + in-memory config. Channels / agents / mesh changes
   * still require a restart — we log a warning so the operator knows.
   */
  private startConfigWatcher(): void {
    const path = this.configPath || resolve(process.cwd(), "agentx.json")
    if (!existsSync(path)) return
    try {
      this.configWatcher = watch(path, { persistent: false }, (eventType) => {
        if (eventType !== "change") return
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => {
          this.reload().catch((e) => this.log(`[reload] failed: ${e?.message || e}`))
        }, 500) // debounce
      })
      this.log(`  Watching ${path} for config changes`)
    } catch (e: any) {
      this.log(`  Config watcher failed to start: ${e.message}`)
    }
  }

  /**
   * Re-read agentx.json, diff against the in-memory config, apply what we
   * can hot-reload (crons, notify-destination, business metadata), and warn
   * about sections that require a daemon restart (channels, agents, mesh,
   * node.bind, providers).
   */
  async reload(): Promise<{ applied: string[]; restartRequired: string[]; error?: string }> {
    let next: DaemonConfig
    try {
      next = loadDaemonConfig(this.configPath)
    } catch (e: any) {
      this.log(`[reload] config invalid, keeping previous: ${e.message}`)
      return { applied: [], restartRequired: [], error: e.message }
    }

    const applied: string[] = []
    const restartRequired: string[] = []

    // 1. Crons — safe to hot-swap (stop + reinit)
    if (JSON.stringify(this.config.crons) !== JSON.stringify(next.crons)) {
      try {
        await this.cron.stop()
        this.cron = new CronScheduler(next, this.registry, this.hooks, this.log)
        this.cron.setNotifyCallback(async (jobId, agent, error, consecutiveErrors) => {
          this.log(`[CRON ALERT] Cron "${jobId}" failed (${consecutiveErrors}x) — ${error.slice(0, 200)}`)
          this.broadcastSSE("cron-failure", JSON.stringify({ jobId, agent, error, consecutiveErrors }))
          const cronDef = next.crons[jobId]
          if (cronDef?.notify) {
            try {
              await this.router.sendOutbound({
                channel: cronDef.notify.channel,
                chatId: cronDef.notify.chatId,
                text: `Cron "${jobId}" failed (${consecutiveErrors}x)\n${error.slice(0, 300)}`,
                agentId: agent,
                accountId: cronDef.notify.accountId,
              })
            } catch (e: any) {
              this.log(`[CRON ALERT] notify send failed: ${e.message}`)
            }
          }
        })
        await this.cron.start()
        applied.push("crons")
      } catch (e: any) {
        this.log(`[reload] cron reload failed: ${e.message}`)
      }
    }

    // 2. Sections that require a restart
    const restartKeys: Array<keyof DaemonConfig> = ["agents", "channels", "mesh", "providers", "node", "services"]
    for (const k of restartKeys) {
      if (JSON.stringify((this.config as any)[k]) !== JSON.stringify((next as any)[k])) {
        restartRequired.push(String(k))
      }
    }

    // 3. Swap in the new config so read-only endpoints (GET /crons etc.) reflect it
    this.config = next

    if (applied.length) this.log(`[reload] applied: ${applied.join(", ")}`)
    if (restartRequired.length) {
      this.log(`[reload] restart required to apply changes in: ${restartRequired.join(", ")}`)
      this.broadcastSSE("reload-partial", JSON.stringify({ applied, restartRequired }))
    } else if (applied.length) {
      this.broadcastSSE("reload-complete", JSON.stringify({ applied }))
    }

    return { applied, restartRequired }
  }

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
        this.hooks,
      )
      // Wire up mesh reaction forwarder — for agents hosted on remote peers
      if (this.mesh) {
        gitlab.setReactForwarder(async (node, project, noteableType, noteableIid, noteId, agentId) => {
          const peer = this.mesh!.directory().find(p => p.peer === node && p.healthy)
          if (!peer) {
            this.log(`[gitlab] react forward: peer "${node}" not found or unhealthy`)
            return
          }
          const url = `${peer.peerUrl}/gitlab/react`
          try {
            const r = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ project, noteableType, noteableIid, noteId, agentId }),
            })
            const respText = await r.text().catch(() => "")
            this.log(`[gitlab] react forward -> ${url} : ${r.status} ${respText.slice(0, 200)}`)
          } catch (e: any) {
            this.log(`[gitlab] react forward FAILED -> ${url} : ${e.message}`)
          }
        })

        // Forward note posting to peer so reply identity stays under the
        // agent's real GitLab user (e.g. @devops-noqta) instead of whatever
        // the local global token resolves to (the group-access-token bot).
        gitlab.setSendNoteForwarder(async (node, project, noteableType, noteableIid, agentId, text): Promise<string> => {
          const peer = this.mesh!.directory().find(p => p.peer === node && p.healthy)
          if (!peer) {
            this.log(`[gitlab] send-note forward: peer "${node}" not found or unhealthy`)
            return ""
          }
          const url = `${peer.peerUrl}/gitlab/send-note`
          try {
            const r = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ project, noteableType, noteableIid, agentId, text }),
            })
            const data = await r.json().catch(() => ({}))
            this.log(`[gitlab] send-note forward -> ${url} : ${r.status} noteId=${(data as any).noteId || "?"}`)
            return (data as any).noteId || ""
          } catch (e: any) {
            this.log(`[gitlab] send-note forward FAILED -> ${url} : ${e.message}`)
            return ""
          }
        })

        // Same for time tracking — peer posts /add_spent_time as its own user.
        gitlab.setLogTimeForwarder(async (node, project, noteableType, noteableIid, agentId, durationMs): Promise<void> => {
          const peer = this.mesh!.directory().find(p => p.peer === node && p.healthy)
          if (!peer) {
            this.log(`[gitlab] log-time forward: peer "${node}" not found or unhealthy`)
            return
          }
          const url = `${peer.peerUrl}/gitlab/log-time`
          try {
            const r = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ project, noteableType, noteableIid, agentId, durationMs }),
            })
            const respText = await r.text().catch(() => "")
            this.log(`[gitlab] log-time forward -> ${url} : ${r.status} ${respText.slice(0, 160)}`)
          } catch (e: any) {
            this.log(`[gitlab] log-time forward FAILED -> ${url} : ${e.message}`)
          }
        })
      }
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

      // Business layer endpoints (/business/status, /business/work, ...)
      if (this.business && path.startsWith("/business")) {
        const handled = await this.business.handleHttp(`${req.method} ${path}`, req, res)
        if (handled) return
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

        case "POST /gitlab/react": {
          // Forwarded from a mesh peer: perform a 👀 reaction using local agent token
          const body = await readBody(req)
          const { project, noteableType, noteableIid, noteId, agentId } = body as any
          const mappings = this.config.channels.gitlab?.agentMappings || []
          const mapping = mappings.find((m: any) => m.agentId === agentId)
          const token = mapping?.token || this.config.channels.gitlab?.token
          const host = this.config.channels.gitlab?.host
          this.log(`[gitlab/react] agent="${agentId}" project="${project}" mappingFound=${!!mapping} mappingToken=${!!mapping?.token} globalToken=${!!this.config.channels.gitlab?.token}(len=${(this.config.channels.gitlab?.token || "").length}) host=${host || "MISSING"}`)
          if (!token || !host) {
            this.json(res, 404, {
              error: "no gitlab token for agent",
              debug: { agentId, mappingFound: !!mapping, hasMappingToken: !!mapping?.token, hasGlobalToken: !!this.config.channels.gitlab?.token, hasHost: !!host },
            })
            break
          }
          const encoded = encodeURIComponent(project)
          const ep = noteableType === "issue"
            ? `${host}/api/v4/projects/${encoded}/issues/${noteableIid}/notes/${noteId}/award_emoji`
            : `${host}/api/v4/projects/${encoded}/merge_requests/${noteableIid}/notes/${noteId}/award_emoji`
          try {
            const glRes = await fetch(ep, {
              method: "POST",
              headers: { "Content-Type": "application/json", "PRIVATE-TOKEN": token },
              body: JSON.stringify({ name: "eyes" }),
            })
            const respBody = await glRes.text().catch(() => "")
            this.log(`[gitlab/react] -> POST ${ep} : ${glRes.status} ${respBody.slice(0, 120)}`)
            this.json(res, 200, { ok: glRes.ok, status: glRes.status, gitlabResponse: respBody.slice(0, 200) })
          } catch (e: any) {
            this.log(`[gitlab/react] FETCH ERROR: ${e.message}`)
            this.json(res, 500, { error: e.message })
          }
          break
        }

        case "POST /gitlab/send-note": {
          // Forwarded from a mesh peer: post a note using local agent token
          // so the comment shows up under the agent's real GitLab user.
          const body = await readBody(req)
          const { project, noteableType, noteableIid, agentId, text } = body as any
          const mappings = this.config.channels.gitlab?.agentMappings || []
          const mapping = mappings.find((m: any) => m.agentId === agentId)
          const token = mapping?.token || this.config.channels.gitlab?.token
          const host = this.config.channels.gitlab?.host
          if (!token || !host) {
            this.json(res, 404, { error: "no gitlab token for agent", debug: { agentId, hasToken: !!token, hasHost: !!host } })
            break
          }
          const encoded = encodeURIComponent(project)
          const ep = noteableType === "issue"
            ? `${host}/api/v4/projects/${encoded}/issues/${noteableIid}/notes`
            : `${host}/api/v4/projects/${encoded}/merge_requests/${noteableIid}/notes`
          try {
            const glRes = await fetch(ep, {
              method: "POST",
              headers: { "Content-Type": "application/json", "PRIVATE-TOKEN": token },
              body: JSON.stringify({ body: text }),
            })
            const respBody = await glRes.text().catch(() => "")
            let noteId = ""
            try { noteId = String((JSON.parse(respBody) as any).id || "") } catch { /* ignore */ }
            this.log(`[gitlab/send-note] agent="${agentId}" -> POST ${ep} : ${glRes.status} noteId=${noteId || "?"}`)
            this.json(res, 200, { ok: glRes.ok, status: glRes.status, noteId })
          } catch (e: any) {
            this.log(`[gitlab/send-note] FETCH ERROR: ${e.message}`)
            this.json(res, 500, { error: e.message })
          }
          break
        }

        case "POST /gitlab/log-time": {
          // Forwarded from a mesh peer: log spent time under the agent's own user.
          const body = await readBody(req)
          const { project, noteableType, noteableIid, agentId, durationMs } = body as any
          const mappings = this.config.channels.gitlab?.agentMappings || []
          const mapping = mappings.find((m: any) => m.agentId === agentId)
          const token = mapping?.token || this.config.channels.gitlab?.token
          const host = this.config.channels.gitlab?.host
          if (!token || !host) {
            this.json(res, 404, { error: "no gitlab token for agent" })
            break
          }
          const totalSeconds = Math.max(60, Math.round(Number(durationMs) / 1000))
          const hours = Math.floor(totalSeconds / 3600)
          const minutes = Math.ceil((totalSeconds % 3600) / 60)
          const duration = hours > 0 ? `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}` : `${minutes}m`
          const encoded = encodeURIComponent(project)
          const seg = noteableType === "merge_request" ? "merge_requests" : "issues"
          const ep = `${host}/api/v4/projects/${encoded}/${seg}/${noteableIid}/add_spent_time`
          try {
            const glRes = await fetch(ep, {
              method: "POST",
              headers: { "Content-Type": "application/json", "PRIVATE-TOKEN": token },
              body: JSON.stringify({ duration }),
            })
            this.log(`[gitlab/log-time] agent="${agentId}" duration=${duration} -> POST ${ep} : ${glRes.status}`)
            this.json(res, 200, { ok: glRes.ok, status: glRes.status, duration })
          } catch (e: any) {
            this.log(`[gitlab/log-time] FETCH ERROR: ${e.message}`)
            this.json(res, 500, { error: e.message })
          }
          break
        }

        case "POST /reload": {
          try {
            const result = await this.reload()
            this.json(res, 200, { ok: true, ...result })
          } catch (e: any) {
            this.json(res, 500, { ok: false, error: e?.message || String(e) })
          }
          break
        }

        case "POST /send": {
          const body = await readBody(req)
          if (!body.channel || !body.chatId || !body.text) {
            this.json(res, 400, { error: "Required: channel, chatId, text" })
            return
          }
          try {
            const messageId = await this.router.sendOutbound({
              channel: body.channel as string,
              chatId: body.chatId as string,
              text: body.text as string,
              replyTo: body.replyTo as string | undefined,
              parseMode: body.parseMode as any,
              agentId: body.agentId as string | undefined,
              accountId: body.accountId as string | undefined,
            })
            this.json(res, 200, { ok: true, messageId: messageId || null })
          } catch (e: any) {
            this.json(res, 400, { error: e.message })
          }
          break
        }

        case "GET /channels":
          this.json(res, 200, this.router.getChannelNames())
          break

        case "GET /services":
          this.json(res, 200, (this.router as any).serviceMatcher?.list() || [])
          break

        case "POST /task": {
          const body = await readBody(req)
          const agentId = (body.agent as string) || this.config.node.defaultAgent
          if (!agentId || !body.message) {
            this.json(res, 400, { error: "Missing: message (and no defaultAgent configured)" })
            return
          }
          const response = await this.registry.execute({
            agentId,
            message: body.message as string,
            context: body.context as any,
          })
          this.json(res, response.error ? 500 : 200, response)
          break
        }

        case "POST /ask":
        case "GET /ask": {
          // Voice-optimized endpoint for Siri/voice assistants
          // Accepts message via body.message (POST) or ?q= (GET)
          const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
          let message = url.searchParams.get("q") || url.searchParams.get("message") || ""
          if (req.method === "POST") {
            const body = await readBody(req)
            message = (body.message as string) || (body.q as string) || message
          }

          const agentId = this.config.node.defaultAgent
          if (!agentId) {
            this.json(res, 400, { error: "No defaultAgent configured in node config" })
            return
          }
          if (!message) {
            this.json(res, 400, { error: "Missing message (pass as ?q=... or {message:...})" })
            return
          }

          // Prepend instruction so the agent responds in a TTS-friendly way
          const voicePrompt = `[VOICE MODE — Your response will be spoken aloud by a TTS engine. Keep it to 2-3 short sentences. Use plain language, no markdown, no code blocks, no bullet points, no URLs. Speak conversationally.]\n\n${message}`

          const response = await this.registry.execute({
            agentId,
            message: voicePrompt,
            context: { channel: "voice", sender: "Siri" },
          })

          // Convert response to speakable text (TTS-friendly)
          const speakable = toSpeakable(response.content)

          this.json(res, response.error ? 500 : 200, {
            text: speakable,
            full: response.content,
            error: response.error,
            duration: response.duration,
          })
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
          const result = await this.mesh.sendTask(body.peer as string, body.message as string, body.agent as string | undefined)
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
              "POST /reload  — re-read agentx.json (hot-swaps crons)",
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

/**
 * Convert text to TTS-friendly speech.
 * Strips markdown, expands technical terms, removes code, handles symbols.
 */
function toSpeakable(text: string): string {
  let s = text

  // Remove code blocks entirely (don't read code aloud)
  s = s.replace(/```[\s\S]*?```/g, ". ")
  s = s.replace(/`[^`]*`/g, "") // inline code

  // Remove markdown syntax characters
  s = s.replace(/\*\*(.*?)\*\*/g, "$1")   // bold
  s = s.replace(/__(.*?)__/g, "$1")       // bold
  s = s.replace(/\*([^*]+)\*/g, "$1")     // italic
  s = s.replace(/_([^_]+)_/g, "$1")       // italic
  s = s.replace(/~~(.*?)~~/g, "$1")       // strikethrough

  // Links: keep text, drop URL
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

  // Images: describe
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, "image$1 ")

  // Headers: remove # markers
  s = s.replace(/^#{1,6}\s+/gm, "")

  // List bullets: convert to pauses
  s = s.replace(/^[\s]*[-*+]\s+/gm, ". ")
  s = s.replace(/^[\s]*\d+\.\s+/gm, ". ")

  // Horizontal rules
  s = s.replace(/^[-=_]{3,}$/gm, "")

  // Blockquotes
  s = s.replace(/^>\s*/gm, "")

  // URLs in plain text: replace with "link"
  s = s.replace(/https?:\/\/\S+/g, "link")

  // File paths: keep readable
  s = s.replace(/\/\w+(\/\w+)+/g, (match) => match.split("/").filter(Boolean).join(" slash "))

  // Technical symbols → words
  s = s.replace(/&/g, " and ")
  s = s.replace(/@/g, " at ")
  s = s.replace(/=>/g, " returns ")
  s = s.replace(/->/g, " to ")
  s = s.replace(/\|/g, " or ")

  // Common abbreviations
  s = s.replace(/\be\.g\./gi, "for example")
  s = s.replace(/\bi\.e\./gi, "that is")
  s = s.replace(/\betc\./gi, "etcetera")
  s = s.replace(/\bvs\.?\b/gi, "versus")

  // Collapse whitespace
  s = s.replace(/\n{2,}/g, ". ")
  s = s.replace(/\n/g, " ")
  s = s.replace(/\s+/g, " ")
  s = s.replace(/\.\s*\./g, ".")
  s = s.replace(/\s+([.,!?])/g, "$1")

  // Strip leading/trailing whitespace and punctuation
  s = s.trim().replace(/^[.,:;]+\s*/, "")

  // Cap at 800 chars for voice UX
  if (s.length > 800) {
    s = s.slice(0, 800).replace(/\s+\S*$/, "") + "..."
  }

  return s
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
