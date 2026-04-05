import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { loadDaemonConfig, validateWorkspaces, type DaemonConfig } from "./config"
import { AgentRegistry } from "@/agents/registry"
import { MessageRouter } from "@/channels/router"
import { TelegramAdapter } from "@/channels/telegram"
import { WhatsAppAdapter } from "@/channels/whatsapp"
import { CronScheduler } from "@/crons/scheduler"
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
  private log: (...args: unknown[]) => void

  constructor(configPath?: string) {
    this.log = console.error.bind(console, "[agentx]")

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

    // Initialize cron scheduler
    this.cron = new CronScheduler(this.config, this.registry, this.hooks, this.log)

    // Initialize mesh (if enabled)
    if (this.config.mesh.enabled) {
      this.mesh = new A2AMesh(this.config, this.log)
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

    // Graceful shutdown
    process.on("SIGINT", () => this.stop())
    process.on("SIGTERM", () => this.stop())
  }

  async stop(): Promise<void> {
    this.log("Shutting down...")
    await this.router.stopAll()
    await this.cron.stop()
    if (this.mesh) await this.mesh.stop()
    if (this.httpServer) {
      this.httpServer.close()
    }
    this.log("Goodbye.")
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
          agentBinding: this.config.channels.whatsapp.agentBinding,
        },
        this.log,
      )
      this.router.addChannel(whatsapp)
      this.log("  WhatsApp: enabled (placeholder)")
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

    this.httpServer.listen(port, host || "127.0.0.1", () => {
      this.log(`  HTTP API: http://${host || "127.0.0.1"}:${port}`)
    })
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
    const path = url.pathname

    try {
      switch (`${req.method} ${path}`) {
        case "GET /health":
          this.json(res, 200, {
            status: "ok",
            node: this.config.node,
            uptime: process.uptime(),
            agents: this.registry.list(),
            crons: this.cron.list().map((j) => ({ id: j.id, enabled: j.enabled, nextRun: j.nextRun })),
            mesh: this.mesh?.directory() || [],
          })
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
