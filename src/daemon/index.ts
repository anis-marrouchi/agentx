import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs"
import { resolve, dirname } from "path"
import { loadDaemonConfig, validateWorkspaces, type DaemonConfig } from "./config"
import { AgentRegistry } from "@/agents/registry"
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
  private httpServer?: ReturnType<typeof createServer>
  private webhooks: WebhookHandler
  private log: (...args: unknown[]) => void

  constructor(configPath?: string) {
    const logger = new Logger("agentx")
    this.log = logger.asConsoleLog()

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

    // Initialize agent registry
    this.registry = new AgentRegistry(this.config, this.log)

    // Initialize message router
    this.router = new MessageRouter(this.registry, this.config, this.hooks, this.log)
    this.webhooks = new WebhookHandler(this.registry, {}, this.log)

    // Initialize cron scheduler
    this.cron = new CronScheduler(this.config, this.registry, this.hooks, this.log)

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

    // 4. Start HTTP API
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
      this.log("  Stopping crons...")
      await this.cron.stop()
    } catch {}

    try {
      if (this.mesh) {
        this.log("  Stopping mesh...")
        await this.mesh.stop()
      }
    } catch {}

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

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
    const path = url.pathname

    try {
      // Dynamic routes (before static switch)
      if (req.method === "POST" && path.startsWith("/webhook/")) {
        await this.webhooks.handle(req, res, path)
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

        case "GET /mesh":
          this.json(res, 200, this.mesh?.directory() || [])
          break

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

        default:
          this.json(res, 404, {
            error: "Not found",
            endpoints: [
              "GET  /health",
              "GET  /agents",
              "GET  /crons",
              "GET  /mesh",
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
