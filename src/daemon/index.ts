import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { writeFileSync, existsSync, unlinkSync, mkdirSync, readFileSync, watch, type FSWatcher } from "fs"
import { resolve, dirname } from "path"
import { loadDaemonConfig, validateWorkspaces, type DaemonConfig } from "./config"
import { AgentRegistry, setGlobalRegistry } from "@/agents/registry"
import { MessageRouter } from "@/channels/router"
import { TelegramAdapter } from "@/channels/telegram"
import { WhatsAppAdapter } from "@/channels/whatsapp"
import { DiscordAdapter } from "@/channels/discord"
import { SlackAdapter } from "@/channels/slack"
import { GitLabAdapter } from "@/channels/gitlab"
import { GitHubAdapter } from "@/channels/github"
import { WebRtcSignalBroker, type WebRtcSignal } from "@/channels/webrtc-signal"
import { CALL_PAGE_HTML } from "./call-page"
import { BotManager } from "./bot-manager"
import { CronScheduler } from "@/crons/scheduler"
import { Logger } from "./logger"
import { WebhookHandler } from "./webhooks"
import { openDb } from "@/storage/sqlite"
import { attachSqliteSubscribers } from "@/storage/subscribers"
import { A2AMesh } from "@/a2a/mesh"
import { HookRegistry, loadHooks } from "@/hooks"
import {
  RunStore as WorkflowRunStore,
  WorkflowDispatcher,
  WorkflowStore,
  startWorkflowTriggers,
  type AgentExecuteRequest,
  type AgentExecuteResponse,
  type MeshForwarder as WorkflowMeshForwarder,
} from "@/workflows"
import { createWorkflowHookHandlers } from "@/workflows/hooks"
import { LandscapeBuilder } from "@/agents/landscape"
import { AgentMemory } from "@/agents/agent-memory"
import { ContactDirectory } from "@/agents/contacts"
import { syncMcpToWorkspace, type McpServerMap } from "@/agents/agent-mcp"
import { REMEMBER_SKILL_BODY, REMEMBER_SKILL_FILENAME } from "@/agents/skills/remember-skill"
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
  private github?: GitHubAdapter
  private webrtc?: WebRtcSignalBroker
  private botManager?: BotManager
  private workflowDispatcher?: WorkflowDispatcher
  private workflowStore?: WorkflowStore
  private workflowRuns?: WorkflowRunStore
  /** Structured per-agent memory (Claude-Code-style user / feedback /
   *  project / reference). Deliberately owned by the daemon (not the
   *  registry) so HTTP callers — including an agent curling from its
   *  own Claude Code session — can write without going through the
   *  dispatcher. Inlined into agent system prompts happens elsewhere. */
  private readonly agentMemory: AgentMemory = new AgentMemory()
  /** Operator-curated contact directory backing /send/contact and the
   *  agentx_send_contact MCP tool. Loaded from .agentx/contacts.json on
   *  startup and on /reload. Initialized in the constructor body (after
   *  `this.log` is assigned) since the directory's reload errors must
   *  surface through the daemon logger. */
  private contacts!: ContactDirectory
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

    // Initialize the contact directory now that `this.log` is available.
    // Empty file (or missing file) is fine — operators populate it later.
    this.contacts = new ContactDirectory(process.cwd(), this.log)

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
      // Let the registry reach the mesh so it can forward unknown-agent
      // tasks to a peer that advertises the requested agent. Keeps
      // workflow authoring portable: a workflow that references
      // `coo-agent` works on any node in the mesh as long as SOMEONE
      // hosts that agent.
      this.registry.setMeshFallback({
        findPeerWithSkill: (skillId) => this.mesh!.findPeerWithSkill(skillId),
        sendTask: (peer, text, agentId) => this.mesh!.sendTask(peer, text, agentId),
        directory: () => this.mesh!.directory(),
      })
    }

    // Initialize webhook handler (after mesh so mesh-forwarding works)
    this.webhooks = new WebhookHandler(this.registry, {}, this.log, this.mesh, this.config.webhooks)

    // Move 2: open SQLite + attach bus subscribers. Best-effort — if the
    // native binding isn't available (operator hasn't run pnpm install),
    // openDb returns null and subscribers are skipped. Existing JSON
    // writes continue regardless. SQLite is observability-grade for now.
    try {
      const db = openDb()
      if (db) {
        attachSqliteSubscribers(db)
        this.log(`  SQLite: ${db.name}`)
      } else {
        this.log(`  SQLite: not opened (native binding unavailable or path unwritable)`)
      }
    } catch (e: any) {
      this.log(`  SQLite: skipped (${e.message})`)
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

    // 5. Schedule midnight cost tracking hook + catch up any missed days.
    // Catch-up is idempotent and bounded to 30 days — a daemon restarted
    // after an outage backfills TOKEN_COSTS.md instead of silently losing
    // those rows. (The previous behavior only ever scheduled tomorrow's
    // midnight run; any restart before midnight lost that day's row.)
    this.scheduleMidnightHook()
    try {
      const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
      const appended = this.registry.getTokenTracker().catchUpTokenCosts(yesterday)
      if (appended.length > 0) {
        this.log(`  Cost tracking: caught up ${appended.length} missed day${appended.length === 1 ? "" : "s"} (${appended[0]}${appended.length > 1 ? ` → ${appended[appended.length - 1]}` : ""})`)
      }
    } catch (err: any) {
      this.log(`  Cost tracking: catch-up failed (non-fatal): ${err.message}`)
    }

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

    // Install the `remember` skill + sync existing memory into each
    // agent's workspace. Write-if-absent for the skill (respect any
    // customizations); replace-in-place for the CLAUDE.md sentinel
    // block and the explicit .agentx-memory.md file.
    this.installAgentMemorySurface()

    // Sync each agent's MCP server config to <workspace>/.mcp.json.
    // Operator-owned files (no agentx marker) are skipped; only files
    // we wrote ourselves are rewritten or removed.
    this.installAgentMcpConfig()

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

    // Drop old task-history folders past the retention window.
    try {
      const removed = this.registry.pruneTaskHistory()
      if (removed > 0) this.log(`  Pruned ${removed} old task-history folder(s)`)
    } catch { /* best-effort */ }

    // Warm the per-agent last-summary cache from disk so dashboard cards have
    // something to show the instant the daemon boots.
    try {
      const loaded = this.registry.hydrateLastSummariesFromDisk()
      if (loaded > 0) this.log(`  Loaded last-activity summaries for ${loaded} agent(s)`)
    } catch { /* best-effort */ }

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

    // Drain active agent tasks before exit. Channels are already stopped, so
    // the active count can only shrink. This is what lets `systemctl restart`
    // survive long-running agent turns (e.g. a 3-minute coder reply) without
    // killing them mid-flight. The inflight log handles messages that hadn't
    // started yet — drain handles ones already executing.
    //
    // Drain ceiling: AGENTX_DRAIN_TIMEOUT_MS (default 300_000 = 5 min). Keep
    // systemd's TimeoutStopSec ≥ this + ~30s margin or systemd will SIGKILL
    // mid-drain.
    try {
      const drainTimeoutMs = parseInt(process.env.AGENTX_DRAIN_TIMEOUT_MS || "300000", 10)
      const drainStart = Date.now()
      const inflightCount = () => this.registry.getActiveTaskCount() + this.router.getActiveMeshForwardCount()
      let active = inflightCount()
      if (active > 0) {
        this.log(`  Draining ${active} in-flight task(s) — local=${this.registry.getActiveTaskCount()}, mesh-forwards=${this.router.getActiveMeshForwardCount()} (max ${Math.round(drainTimeoutMs / 1000)}s)...`)
        while (active > 0 && Date.now() - drainStart < drainTimeoutMs) {
          await new Promise(r => setTimeout(r, 500))
          active = inflightCount()
        }
        const elapsedMs = Date.now() - drainStart
        if (active === 0) {
          this.log(`  Drain complete (${elapsedMs}ms)`)
        } else {
          this.log(`  Drain timeout after ${elapsedMs}ms — ${active} task(s) still in flight (local=${this.registry.getActiveTaskCount()}, mesh-forwards=${this.router.getActiveMeshForwardCount()}), exiting anyway`)
        }
      }
    } catch (e: any) {
      this.log(`  Drain error: ${e.message}`)
    }

    try {
      // Persist router dedup + any debounced per-channel state before exit so
      // a clean stop doesn't drop the last in-memory window of processed ids.
      this.router.flushPersistence?.()
    } catch (e: any) {
      this.log(`  Router flush error: ${e.message}`)
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

    try {
      if (this.botManager) {
        this.botManager.shutdown()
      }
    } catch {}

    try {
      if (this.webrtc) {
        this.webrtc.shutdown()
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

    // 2. Telegram accounts — hot-swap where we can. Adding a new bot account
    //    (or rotating an existing token) used to need a full restart; now the
    //    adapter diffs the new map against its live account set and starts/
    //    stops poll loops surgically. Router also gets the fresh config so
    //    send-side paths resolve the new token. Policy.allowFrom flips through
    //    effectiveAllowFrom without restart.
    const tgPrev = this.config.channels?.telegram
    const tgNext = next.channels?.telegram
    const tgChanged = JSON.stringify(tgPrev) !== JSON.stringify(tgNext)
    let tgHandled = false
    if (tgChanged && tgNext?.enabled) {
      const telegram = this.router.getChannel("telegram") as TelegramAdapter | undefined
      if (telegram) {
        try {
          const diff = await telegram.reloadAccounts(tgNext.accounts, tgNext.policy)
          this.router.updateConfig(next)
          const parts: string[] = []
          if (diff.added.length) parts.push(`+${diff.added.join(",")}`)
          if (diff.removed.length) parts.push(`-${diff.removed.join(",")}`)
          if (diff.tokenChanged.length) parts.push(`~${diff.tokenChanged.join(",")}`)
          applied.push(parts.length ? `telegram(${parts.join(" ")})` : "telegram")
          tgHandled = true
        } catch (e: any) {
          this.log(`[reload] telegram hot-reload failed: ${e.message}`)
        }
      }
    } else if (tgChanged && !tgNext?.enabled && tgPrev?.enabled) {
      // enabled→disabled transition still needs a restart — the adapter and
      // the channels Map can't be torn down cleanly mid-flight.
      tgHandled = false
    } else if (tgChanged && tgNext?.enabled && !tgPrev?.enabled) {
      // disabled→enabled: adapter doesn't exist yet, needs full init path.
      tgHandled = false
    } else if (!tgChanged) {
      tgHandled = true // no change, nothing to do
    }

    // 3. Providers — hot-swap the credential table. Registry re-reads it
    //    per-task execution, so rotating API keys or adding a provider lands
    //    instantly for the next task (in-flight tasks keep their closure).
    if (JSON.stringify(this.config.providers) !== JSON.stringify(next.providers)) {
      try {
        this.registry.setProviders(next.providers)
        applied.push("providers")
      } catch (e: any) {
        this.log(`[reload] providers hot-reload failed: ${e.message}`)
      }
    }

    // 4. Mesh peers — diff the peer list: adds, removes, and url/token
    //    rotations are handled in-place and trigger an immediate rediscovery
    //    for changed peers. Health-check interval change needs restart.
    const meshPrev = this.config.mesh
    const meshNext = next.mesh
    const meshChanged = JSON.stringify(meshPrev) !== JSON.stringify(meshNext)
    let meshHandled = !meshChanged
    if (meshChanged && meshNext.enabled && meshPrev.enabled && this.mesh) {
      // Only the peers list and per-peer url/token are hot. healthCheck
      // interval/timeout changes still need a restart because we'd have to
      // re-install setInterval.
      const intervalChanged = JSON.stringify(meshPrev.healthCheck) !== JSON.stringify(meshNext.healthCheck)
      if (!intervalChanged) {
        try {
          const diff = await this.mesh.reloadPeers(next)
          const parts: string[] = []
          if (diff.added.length) parts.push(`+${diff.added.join(",")}`)
          if (diff.removed.length) parts.push(`-${diff.removed.join(",")}`)
          if (diff.updated.length) parts.push(`~${diff.updated.join(",")}`)
          applied.push(parts.length ? `mesh(${parts.join(" ")})` : "mesh")
          meshHandled = true
        } catch (e: any) {
          this.log(`[reload] mesh hot-reload failed: ${e.message}`)
        }
      }
    }

    // 5. Services — recompile the matcher's regex table. match() is sync and
    //    stateless, so a swap between iterations is safe.
    if (JSON.stringify(this.config.services) !== JSON.stringify(next.services)) {
      try {
        const matcher = this.router.getServiceMatcher()
        if (matcher) {
          const { count } = matcher.reload(next.services)
          applied.push(`services(${count})`)
        } else if (Object.keys(next.services).length > 0) {
          // Services went from empty at boot to non-empty — we never created
          // a matcher, so we do create one now and wire it into the router.
          const fresh = new ServiceMatcher(next.services, this.log)
          this.router.setServiceMatcher(fresh)
          applied.push(`services(${Object.keys(next.services).length})`)
        }
      } catch (e: any) {
        this.log(`[reload] services hot-reload failed: ${e.message}`)
      }
    }

    // 6. Hooks — clear + reload from disk. Registry is just a Map<event, defs>
    //    so the swap is atomic between events.
    try {
      const beforeSize = this.hooks.size?.() ?? 0
      this.hooks.clear()
      loadHooks(process.cwd(), this.hooks)
      const afterSize = this.hooks.size?.() ?? 0
      if (beforeSize !== afterSize) applied.push(`hooks(${afterSize})`)
    } catch (e: any) {
      this.log(`[reload] hooks reload failed: ${e.message}`)
    }

    // 7. Landscape — cheap rebuild, always safe.
    if (JSON.stringify(this.config.business) !== JSON.stringify(next.business)
        || JSON.stringify(this.config.agents) !== JSON.stringify(next.agents)) {
      try {
        this.landscape = new LandscapeBuilder(next)
        this.registry.setLandscape(this.landscape)
        applied.push("landscape")
      } catch (e: any) {
        this.log(`[reload] landscape rebuild failed: ${e.message}`)
      }
      // Phase 4: when agents change locally, kick mesh peers to re-probe
      // us — and equally re-probe THEM so their roster changes are pulled
      // into our directory without waiting up to a full health-check tick.
      // Closes the "newly-added remote agent silently unreachable for up
      // to 60s" symptom the operator reported.
      if (this.mesh && this.mesh.peerCount() > 0) {
        try {
          const refreshed = await this.mesh.refreshAll()
          const healthy = refreshed.filter(r => r.healthy).length
          applied.push(`mesh.refresh(${healthy}/${refreshed.length})`)
        } catch (e: any) {
          this.log(`[reload] mesh refresh failed: ${e.message}`)
        }
      }
    }

    // 8. Sections that still require a full restart — narrowed down to:
    //    agents (runtime state captured per-task), node.bind (listen socket),
    //    non-telegram channels (session-bound sockets), mesh.healthCheck
    //    (interval timer), and enabling/disabling a channel adapter wholesale.
    if (JSON.stringify(this.config.agents) !== JSON.stringify(next.agents)) {
      // Let registry swap the config reference so landscape/business reads
      // pick up new agent metadata (avatar, access, tier display). New
      // physical agents (adding/removing keys) still need restart because
      // the registry initializes state maps on construction.
      const oldIds = Object.keys(this.config.agents).sort().join(",")
      const newIds = Object.keys(next.agents).sort().join(",")
      if (oldIds === newIds) {
        // Same set of agent ids — hot-swap config-only fields through the
        // registry. Model changes still need a restart because Claude Code
        // subprocesses capture it at spawn; we surface this below.
        this.registry.setConfig(next)
        applied.push("agents.meta")
      }
      // Detect which specific fields changed and whether restart is needed.
      const restartFields = detectAgentRestartFields(this.config.agents, next.agents)
      if (restartFields.length > 0) {
        restartRequired.push(`agents(${restartFields.join(",")})`)
      }
    }

    if (!meshHandled) restartRequired.push("mesh")
    if (JSON.stringify(this.config.node) !== JSON.stringify(next.node)) {
      restartRequired.push("node")
    }
    // Channels: hot-handle telegram, everything else is still restart-required.
    const channelsPrevMinusTg = { ...this.config.channels, telegram: undefined }
    const channelsNextMinusTg = { ...next.channels, telegram: undefined }
    if (JSON.stringify(channelsPrevMinusTg) !== JSON.stringify(channelsNextMinusTg)) {
      restartRequired.push("channels")
    } else if (tgChanged && !tgHandled) {
      restartRequired.push("channels.telegram")
    }

    // 8a. Contact directory — re-read .agentx/contacts.json. The contacts
    //     file is independent of agentx.json (operator-managed, sibling of
    //     .agentx/sessions); reloading it here lets `agentx_send_contact`
    //     pick up edits without a daemon restart.
    {
      const before = this.contacts.size()
      const result = this.contacts.reload()
      if (result.error) {
        this.log(`[reload] contacts.json invalid: ${result.error}`)
      } else if (result.count !== before) {
        applied.push(`contacts(${result.count})`)
      }
    }

    // 8b. Webhook entries — hot-reload triggers / secretEnv / mesh routes
    //     without a daemon bounce. Phase 4 closes the recurring complaint
    //     that adding a webhook route to agentx.json required a restart.
    if (JSON.stringify(this.config.webhooks) !== JSON.stringify(next.webhooks)) {
      try {
        this.webhooks.setWebhookEntries(next.webhooks)
        applied.push(`webhooks(${next.webhooks.length})`)
      } catch (e: any) {
        this.log(`[reload] webhooks hot-reload failed: ${e.message}`)
      }
    }

    // 9. Swap in the new config so read-only endpoints (GET /crons etc.)
    //    reflect it, and router send-side paths see fresh channel config.
    this.config = next
    this.router.updateConfig(next)

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

    // Idempotent guard — catch-up at startup may have already appended this
    // date, and a timer-edge double-fire would otherwise produce duplicate
    // rows (as happened with the 2026-04-08 duplicate in the current file).
    if (tracker.hasTokenCostsEntry(yesterday)) {
      this.log(`  Cost tracking: ${yesterday} already logged, skipping`)
      return
    }

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
        const policy = this.config.channels.telegram.policy
        const telegram = new TelegramAdapter(
          accounts,
          { policy: { allowFrom: policy?.allowFrom } },
          this.log,
        )
        this.router.addChannel(telegram)
        const globalSize = policy?.allowFrom?.length ?? 0
        const closedAccts = Object.entries(accounts).filter(
          ([, c]) => !c.allowFrom && globalSize === 0,
        ).length
        if (closedAccts > 0) {
          this.log(
            `  Telegram: enabled — WARNING: ${closedAccts} account(s) have no allowFrom (global or per-account). All incoming messages will be DROPPED.`,
          )
        } else {
          this.log(`  Telegram: enabled — global allowFrom entries: ${globalSize}`)
        }
      }
    }

    // WhatsApp
    if (this.config.channels.whatsapp.enabled) {
      const { setWhatsAppQR, setWhatsAppStatus } = await import("./whatsapp-state")
      const whatsapp = new WhatsAppAdapter(
        {
          sessionDir: this.config.channels.whatsapp.sessionDir,
          defaultAgent: this.config.channels.whatsapp.defaultAgent,
          allowFrom: this.config.channels.whatsapp.allowFrom,
          routes: this.config.channels.whatsapp.routes,
          // Throttle for live Baileys reads (ingestor). Defaults in the
          // adapter are conservative; operators can tighten/loosen via
          // channels.whatsapp.ingest.throttle.
          throttle: {
            minMsBetweenCalls: this.config.channels.whatsapp.ingest?.throttle?.minMsBetweenCalls,
            maxCallsPerMinute: this.config.channels.whatsapp.ingest?.throttle?.maxCallsPerMinute,
          },
          // Publish QR + status so /api/admin/channels/whatsapp/state can
          // surface the pairing code in the browser.
          onQR: setWhatsAppQR,
          onStatus: setWhatsAppStatus,
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

    // Slack
    if (this.config.channels.slack?.enabled && this.config.channels.slack.botToken && this.config.channels.slack.appToken) {
      const slack = new SlackAdapter(
        {
          botToken: this.config.channels.slack.botToken,
          appToken: this.config.channels.slack.appToken,
          agentBinding: this.config.channels.slack.agentBinding,
        },
        this.log,
      )
      this.router.addChannel(slack)
      this.log("  Slack: enabled")
    } else if (this.config.channels.slack?.enabled) {
      this.log("  Slack: enabled in config but missing botToken/appToken — skipped")
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
          // Every agent becomes an @-mention target on GitLab by default.
          // Explicit agentMappings above take precedence (per-agent token,
          // custom usernames); anything else gets a default derivation on
          // (re)start. Add/remove an agent → no GitLab config change needed.
          knownAgentIds: Object.keys(this.config.agents),
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

    // GitHub
    if (this.config.channels.github?.enabled) {
      const githubConfig = this.config.channels.github
      this.github = new GitHubAdapter(
        {
          token: githubConfig.token,
          tokenFile: githubConfig.tokenFile,
          appId: githubConfig.appId,
          clientId: githubConfig.clientId,
          privateKeyFile: githubConfig.privateKeyFile,
          webhookSecret: githubConfig.webhookSecret,
          routes: githubConfig.routes,
          agentMappings: githubConfig.agentMappings,
        },
        this.log,
      )
      // Wire mesh comment forwarder for remote agents
      if (this.mesh) {
        this.github.setSendCommentForwarder(async (node, repo, issueNumber, agentId, text): Promise<string> => {
          const peer = this.mesh!.directory().find(p => p.peer === node && p.healthy)
          if (!peer) {
            this.log(`[github] send-comment forward: peer "${node}" not found or unhealthy`)
            return ""
          }
          const url = `${peer.peerUrl}/github/send-comment`
          try {
            const r = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ repo, issueNumber, agentId, text }),
            })
            const data = await r.json().catch(() => ({}))
            this.log(`[github] send-comment forward -> ${url} : ${r.status} commentId=${(data as any).commentId || "?"}`)
            return (data as any).commentId || ""
          } catch (e: any) {
            this.log(`[github] send-comment forward FAILED -> ${url} : ${e.message}`)
            return ""
          }
        })
      }
      this.router.addChannel(this.github)
      this.log(`  GitHub: enabled (${githubConfig.routes.length} repo routes)`)
    }

    // WebRTC signaling — control plane only. Media flows browser-to-browser
    // via WebRTC direct, never through this daemon. See src/channels/webrtc-signal.ts.
    if (this.config.channels.webrtc?.enabled) {
      const wrtcCfg = this.config.channels.webrtc
      this.webrtc = new WebRtcSignalBroker(
        this.config.node.name,
        wrtcCfg.allowedCallers,
        this.log,
      )
      if (this.mesh) {
        this.webrtc.setForwarder(async (peer, signal) => {
          try {
            return await this.mesh!.sendSignal(peer, signal)
          } catch (e: any) {
            this.log(`[webrtc] forward to "${peer}" failed: ${e.message}`)
            return false
          }
        })
      }
      // Ring notifications: when a remote peer rings us, emit a "tap to join"
      // message through each configured channel so the callee actually sees
      // the incoming call even if their browser isn't open.
      if (wrtcCfg.ringNotify.length > 0) {
        const urlBase = wrtcCfg.callUrlBase || `http://${this.config.node.bind}`
        this.webrtc.setRingHandler(async (signal) => {
          const link = `${urlBase}/call?to=${encodeURIComponent(signal.from)}&callId=${encodeURIComponent(signal.callId)}`
          const text = `📞 ${signal.from} is calling — tap to join: ${link}`
          for (const target of wrtcCfg.ringNotify) {
            try {
              await this.router.sendOutbound({
                channel: target.channel,
                chatId: target.chatId,
                text,
                parseMode: "plain",
                ...(target.accountId ? { accountId: target.accountId } : {}),
              })
            } catch (e: any) {
              this.log(`[webrtc] ring notify via ${target.channel}:${target.chatId} failed: ${e.message}`)
            }
          }
        })
      }
      // AI participant ("bot") — server-side WebRTC peer that joins on
      // ?bot=<id>, transcribes remote audio, posts chunks to a channel.
      if (wrtcCfg.bot.enabled) {
        const botCfg = wrtcCfg.bot
        const iceServers: RTCIceServer[] = [
          ...wrtcCfg.stunServers.map(urls => ({ urls })),
          ...wrtcCfg.turnServers,
        ]
        this.botManager = new BotManager({
          broker: this.webrtc,
          iceServers,
          whisperBackend: botCfg.whisperBackend,
          whisperModel: botCfg.whisperModel,
          whisperLanguage: botCfg.whisperLanguage,
          mlxBinary: botCfg.mlxBinary,
          maxCallMinutes: botCfg.maxCallMinutes,
          log: this.log,
          onTranscript: async ({ invite, text, durationMs }) => {
            const dest = botCfg.transcriptChannel
            if (!dest) return
            const stamp = `[${new Date().toLocaleTimeString()} • ${(durationMs / 1000).toFixed(1)}s • ${invite.target}]`
            try {
              await this.router.sendOutbound({
                channel: dest.channel,
                chatId: dest.chatId,
                text: `${stamp}\n${text}`,
                parseMode: "plain",
                ...(dest.accountId ? { accountId: dest.accountId } : {}),
              })
            } catch (e: any) {
              this.log(`[bot-manager] transcript send via ${dest.channel}:${dest.chatId} failed: ${e.message}`)
            }
          },
        })
        this.log(`  WebRTC bot: enabled (whisper=${botCfg.whisperBackend}, default-agent=${botCfg.defaultAgentId || "(none)"}, transcript=${botCfg.transcriptChannel ? `${botCfg.transcriptChannel.channel}:${botCfg.transcriptChannel.chatId}` : "(none)"})`)
      }
      this.log(`  WebRTC signaling: enabled (stun=${wrtcCfg.stunServers.length}, turn=${wrtcCfg.turnServers.length}, allowedCallers=${wrtcCfg.allowedCallers.length || "all"}, ringNotify=${wrtcCfg.ringNotify.length}, bot=${wrtcCfg.bot.enabled ? "on" : "off"})`)
    }

    // Workflow engine — register hook subscribers BEFORE startAll so a
    // webhook arriving immediately sees an engine ready to evaluate. Skipped
    // when `workflows.enabled` is false to keep existing installs silent.
    await this.bootWorkflowEngine()

    // Wire SessionStore to the channel adapters so cold-create sessions can
    // call adapter.seedHistory() and mirror the live channel before the
    // first turn renders. Installed AFTER all addChannel calls (above) so
    // the resolver sees the full channel set.
    this.registry.getSessionStore().setAdapterResolver((channel) => this.router.getChannel(channel))

    await this.router.startAll()
  }

  /** Wires the workflow dispatcher + hook subscribers against the running
   *  daemon. No-op when `workflows.enabled` is false — the observability
   *  page + editor still work (they read/write disk directly via the
   *  board-dashboard routes), but no transitions fire. */
  private async bootWorkflowEngine(): Promise<void> {
    const cfg = this.config.workflows
    if (!cfg?.enabled) {
      this.log("  Workflows: disabled (set workflows.enabled to turn the engine on)")
      return
    }

    const store = new WorkflowStore({ baseDir: resolve(process.cwd(), cfg.dir) })
    const runs = new WorkflowRunStore({ baseDir: resolve(process.cwd(), cfg.dir), nodeId: this.config.node.id })

    // channels record: name -> adapter instance. Node handlers narrow to the
    // specific method they need (send / createIssue / logTimeSpent / ...).
    const channels: Record<string, unknown> = {}
    for (const name of this.router.getChannelNames()) {
      const adapter = this.router.getChannel(name)
      if (adapter) channels[name] = adapter
    }

    // Agent-execute shim for the `agent` node handler. Awaits AgentRegistry
    // inside the walk loop — the walk itself runs in a background async
    // context detached from the webhook response, so long-running agent
    // calls don't block webhook delivery.
    const agents = {
      execute: async (req: AgentExecuteRequest): Promise<AgentExecuteResponse> => {
        const start = Date.now()
        try {
          const resp = await this.registry.execute({
            agentId: req.agentId,
            message: req.message,
            workflowRunId: req.workflowRunId,
            timeoutMinutes: req.timeoutMinutes,
          })
          return {
            content: resp.content ?? "",
            error: resp.error,
            taskId: `wf-${req.workflowRunId ?? "na"}-${start.toString(36)}`,
            durationMs: Date.now() - start,
          }
        } catch (e: any) {
          return { content: "", error: e.message }
        }
      },
    }

    // Mesh forwarder: when an event arrives here but the run is home'd on
    // another peer, POST directly to the peer's /workflow/event endpoint.
    // Also handles trigger fan-out: a fresh channel event arriving locally
    // is broadcast to every healthy peer so peer-side workflows with
    // `mesh.allowRemote: true` can match. Each receiver runs its own dispatch
    // with `fromRemote` set, scoping the match to opted-in workflows.
    const forwarder: WorkflowMeshForwarder | undefined = this.mesh ? {
      forwardTransition: async (peerName, payload) => {
        const peer = this.mesh!.directory().find((p) => p.peer === peerName && p.healthy)
        if (!peer) {
          this.log(`[workflows] forward to "${peerName}" skipped — peer not found or unhealthy`)
          return
        }
        const url = `${peer.peerUrl}/workflow/event`
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payload }),
          })
          if (!r.ok) this.log(`[workflows] forward ${url} -> ${r.status}`)
        } catch (e: any) {
          this.log(`[workflows] forward ${url} failed: ${e.message}`)
        }
      },
      broadcastTrigger: async (payload) => {
        const peers = this.mesh!.directory().filter((p) => p.healthy)
        if (peers.length === 0) return
        const localPeerName = this.config.node.id
        // Visibility: emit one summary line per broadcast so operators can see
        // a channel event leaving the originating node and trace the round
        // trip (look for a matching `[workflows/mesh] received trigger ...`
        // on the receiving peer).
        this.log(`[workflows/mesh] broadcasting trigger source="${payload.trigger.source}" chat="${payload.trigger.chat ?? "*"}" -> ${peers.length} peer(s): ${peers.map((p) => p.peer).join(", ")}`)
        await Promise.allSettled(peers.map(async (peer) => {
          const url = `${peer.peerUrl}/workflow/event`
          try {
            const r = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              // Receiver discriminates on `kind: "trigger"` and dispatches
              // with fromRemote.peer = the originating node id. Peers without
              // an opted-in workflow no-op cleanly.
              body: JSON.stringify({ kind: "trigger", fromPeer: localPeerName, payload }),
              signal: AbortSignal.timeout(5000),
            })
            if (!r.ok) this.log(`[workflows/mesh] broadcastTrigger ${peer.peer} -> ${r.status}`)
          } catch (e: any) {
            this.log(`[workflows/mesh] broadcastTrigger ${peer.peer} failed: ${e.message}`)
          }
        }))
      },
      forwardChannelSend: async (payload) => {
        // Find a healthy peer that hosts this channel. Channels are typically
        // unique to a node (whatsapp on clawd-server, telegram on macbook),
        // so we just take the first hit. If multiple peers somehow host the
        // same channel, this picks deterministically by directory order.
        const peers = this.mesh!.directory().filter((p) => p.healthy && p.channels?.includes(payload.channel))
        if (peers.length === 0) {
          throw new Error(`no healthy mesh peer hosts channel "${payload.channel}"`)
        }
        const target = peers[0]
        const url = `${target.peerUrl}/channel/send`
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        })
        if (!r.ok) {
          const txt = await r.text().catch(() => "")
          throw new Error(`peer ${target.peer} /channel/send -> ${r.status} ${txt.slice(0, 200)}`)
        }
        const body = await r.json().catch(() => ({})) as { messageId?: string | null }
        return { messageId: body.messageId ?? null }
      },
    } : undefined

    // Build the Telegram user-task renderer if the Telegram adapter is
    // active. The renderer posts a notification to each assignee's
    // preferred channel when a userTask node pauses the run.
    const { ActorStore } = await import("@/actors/store")
    const { TaskStore } = await import("@/workflows/task-store")
    const actorStore = new ActorStore()
    const taskStore = new TaskStore(cfg.dir ? { baseDir: resolve(process.cwd(), cfg.dir) } : undefined)
    const inboxBaseUrl = process.env.AGENTX_INBOX_BASE_URL || ""
    const taskRenderers: Array<(t: import("@/workflows/task-store").UserTaskRecord) => Promise<void>> = []

    const telegramAdapter = channels["telegram"] as {
      sendMessage?: (msg: { chatId: string; text: string; parseMode?: string; accountId?: string }) => Promise<string | undefined | void>
      sendWithInlineButtons?: (args: { chatId: string; text: string; buttons: Array<{ label: string; url: string }>; parseMode?: "markdown" | "html" | "plain"; accountId?: string }) => Promise<string | undefined | void>
    } | undefined
    if (telegramAdapter?.sendMessage) {
      const { createTelegramTaskRenderer } = await import("@/forms/renderers/telegram")
      taskRenderers.push(createTelegramTaskRenderer({
        actors: actorStore,
        tasks: taskStore,
        adapter: {
          sendMessage: telegramAdapter.sendMessage.bind(telegramAdapter),
          sendWithInlineButtons: telegramAdapter.sendWithInlineButtons?.bind(telegramAdapter),
        },
        inboxBaseUrl,
        log: (m) => this.log(m),
      }))
    }

    const whatsappAdapter = channels["whatsapp"] as {
      send?: (msg: { channel: string; chatId: string; text: string; parseMode?: "markdown" | "html" | "plain" }) => Promise<string | void>
    } | undefined
    if (whatsappAdapter?.send) {
      const { createWhatsappTaskRenderer } = await import("@/forms/renderers/whatsapp")
      taskRenderers.push(createWhatsappTaskRenderer({
        actors: actorStore,
        tasks: taskStore,
        adapter: { send: whatsappAdapter.send.bind(whatsappAdapter) },
        inboxBaseUrl,
        log: (m) => this.log(m),
      }))
    }

    const slackAdapter = channels["slack"] as {
      send?: (msg: { channel: string; chatId: string; text: string; parseMode?: "markdown" | "html" | "plain" }) => Promise<string | void>
    } | undefined
    if (slackAdapter?.send) {
      const { createSlackTaskRenderer } = await import("@/forms/renderers/slack")
      taskRenderers.push(createSlackTaskRenderer({
        actors: actorStore,
        tasks: taskStore,
        adapter: { send: slackAdapter.send.bind(slackAdapter) },
        inboxBaseUrl,
        log: (m) => this.log(m),
      }))
    }

    // Compose into a single callback that fans out to every registered
    // per-channel renderer. Each renderer short-circuits when the
    // assignee has no handle on its channel, so delivery lands on
    // whichever channel the actor has configured without double-posting.
    const renderUserTask: ((task: import("@/workflows/task-store").UserTaskRecord) => Promise<void>) | undefined =
      taskRenderers.length
        ? async (task) => { for (const r of taskRenderers) { try { await r(task) } catch { /* already logged per-renderer */ } } }
        : undefined

    const { TimerService } = await import("@/workflows/timers")
    const timerService = new TimerService({
      baseDir: cfg.dir ? resolve(process.cwd(), cfg.dir) : undefined,
      log: (m) => this.log(m),
    })

    const dispatcher = new WorkflowDispatcher({
      store, runs,
      nodeId: this.config.node.id,
      channels,
      agents,
      forwarder,
      actors: actorStore,
      tasks: taskStore,
      timers: timerService,
      renderUserTask,
      log: (m) => this.log(m),
    })

    // Start the tick loop now that the dispatcher has registered its
    // resume-on-fire callback. Timers persisted from a prior run will be
    // picked up on the first tick.
    timerService.start()

    // Subscribe the built-in hook handlers.
    const handlers = createWorkflowHookHandlers(dispatcher)
    for (const [event, handler] of Object.entries(handlers)) {
      if (!handler) continue
      this.hooks.registerHandler(event as any, `workflows:${event}`, handler, 50)
    }

    // Stash for the mesh receiver endpoint and for manual-run RPC — see the
    // HTTP handler in startHttpApi where /workflow/transition arrives.
    this.workflowDispatcher = dispatcher
    this.workflowStore = store
    this.workflowRuns = runs
    // Phase 3: webhook handler can now dispatch workflows per event-type
    // (webhooks[].triggers map). When `triggers` is unset, behavior is
    // unchanged from prior versions.
    this.webhooks.setWorkflowDispatcher(dispatcher)

    // Phase 3: wire trigger.cron timers + trigger.hook subscribers for
    // workflows that declare them. Channel-triggered workflows (gitlab-issue,
    // whatsapp-message, ...) are already wired via the hooks registered
    // above.
    const { cronTimers, hookSubscribers } = startWorkflowTriggers({
      store, dispatcher, hooks: this.hooks, log: (m) => this.log(m),
    })

    const count = store.list().length
    this.log(`  Workflows: enabled (${count} definition${count === 1 ? "" : "s"} loaded from ${cfg.dir}, editor=${cfg.editor}, cron=${cronTimers}, hook=${hookSubscribers})`)
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

  /**
   * Stream a single running task's live output as SSE.
   * Sends a `start` event with the existing buffer (so a late opener catches up),
   * then `chunk` events for every new delta, and `end` when the task finishes.
   */
  private handleTaskStream(req: IncomingMessage, res: ServerResponse, _agentId: string, taskId: string): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    })
    let closed = false
    const send = (ev: string, data: unknown) => {
      if (closed) return
      try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`) } catch { closed = true }
    }
    const sub = this.registry.subscribeToTaskOutput(taskId, (chunk) => send("chunk", { text: chunk }))
    if (!sub) {
      send("error", { message: "task not found or already evicted" })
      res.end()
      return
    }
    send("start", { taskId, initial: sub.initial, done: sub.done })
    if (sub.done) {
      send("end", { reason: "already finished" })
      res.end()
      return
    }
    // Heartbeat so proxies don't kill idle SSE connections.
    const heartbeat = setInterval(() => { if (!closed) try { res.write(": ping\n\n") } catch { /* */ } }, 15000)
    req.on("close", () => {
      closed = true
      clearInterval(heartbeat)
      sub.unsubscribe()
    })
  }

  /**
   * SSE stream for WebRTC signaling. Browser connects here identifying itself
   * with (callId, as). The broker fans out any signal addressed `to=<as>` on
   * this `callId` to the stream.
   */
  private handleWebRtcSSE(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!this.webrtc) {
      this.json(res, 404, { error: "WebRTC signaling not enabled" })
      return
    }
    const callId = url.searchParams.get("callId")
    const as = url.searchParams.get("as")
    if (!callId || !as) {
      this.json(res, 400, { error: "Missing ?callId= and ?as=" })
      return
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    })
    res.write(`event: ready\ndata: ${JSON.stringify({ callId, as })}\n\n`)
    const unsubscribe = this.webrtc.subscribe(callId, as, res)
    // Proxies kill idle SSE; ping every 15s.
    const heartbeat = setInterval(() => {
      try { res.write(": ping\n\n") } catch { /* best effort */ }
    }, 15000)
    req.on("close", () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  }

  /**
   * Serve the minimal browser call page. Static HTML; no framework.
   * The page does getUserMedia, RTCPeerConnection, and POSTs/listens signals.
   */
  private serveCallPage(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(CALL_PAGE_HTML)
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

      // WebRTC signaling SSE stream (browser subscribes here to receive
      // offers/answers/ICE forwarded by the daemon).
      if (req.method === "GET" && path === "/webrtc/events") {
        this.handleWebRtcSSE(req, res, url)
        return
      }

      // --- Workflow RPC endpoints ---
      //
      // /workflow/transition — mesh receiver. Peer node B forwarded a
      //   triggering event here because this node is the run's home. We
      //   just re-enter the local dispatcher with the payload.
      //
      // /workflows/:id/run — manual trigger. The CLI's `agentx workflow
      //   run <id> --input ...` POSTs here. Only workflows whose trigger
      //   source is "manual" are allowed.
      // Workflow mesh + manual-run endpoints. /workflow/event receives
      // forwarded dispatches from peers when the run is home'd here.
      // /workflows/:id/run fires a manual-triggered workflow.
      if (req.method === "POST" && (path === "/workflow/event" || path === "/workflow/transition")) {
        await this.handleWorkflowEvent(req, res)
        return
      }
      if (req.method === "POST" && path === "/channel/send") {
        await this.handleChannelSend(req, res)
        return
      }
      // Known-chats discovery. Local if this node hosts the channel; else
      // forward to a peer that does. Lets the workflow editor populate a
      // chatId picker without authors memorizing platform ids. The `local=1`
      // query param suppresses mesh fan-out so peer-to-peer recursion
      // (both nodes advertise the same channel) can't loop forever.
      const channelChatsMatch = req.method === "GET" && path.match(/^\/channels\/([^/]+)\/chats$/)
      if (channelChatsMatch) {
        const localOnly = url.searchParams.get("local") === "1"
        await this.handleChannelChats(res, decodeURIComponent(channelChatsMatch[1]), { localOnly })
        return
      }
      const manualRun = req.method === "POST" && path.match(/^\/workflows\/([^/]+)\/run$/)
      if (manualRun) {
        await this.handleWorkflowManualRun(req, res, decodeURIComponent(manualRun[1]))
        return
      }

      // Agent-memory API — lets running Claude Code sessions save their
      // own experiential memory from inside a Bash tool call.
      //   GET  /api/memory?agent=<id>            → list records + MEMORY.md
      //   GET  /api/memory/<id>?agent=<id>       → one record
      //   POST /api/memory  body: {agentId, type, name, description, body, append?}
      //   DELETE /api/memory/<name>?agent=<id>   → remove
      if (path.startsWith("/api/memory")) {
        if (await this.handleMemoryApi(req, res, path, url)) return
      }

      // BPM user-task API: list + submit. Lives on the main daemon
      // because the dispatcher is the one that drives run resumes.
      if (path.startsWith("/api/workflows/tasks") && this.workflowDispatcher) {
        if (await this.handleTaskApi(req, res, path)) return
      }
      // GET /api/workflows/kpis — actor-level + total task stats.
      if (req.method === "GET" && path === "/api/workflows/kpis" && this.workflowDispatcher) {
        const { computeKpis } = await import("@/workflows/task-store")
        this.json(res, 200, computeKpis(this.workflowDispatcher.tasks))
        return
      }
      // GET /api/workflows/runs[?limit=&workflowId=] + /runs/:id
      // Runs live on the node that dispatches them (home-node). The
      // board-dashboard on another host proxies to this endpoint so
      // "Recent runs" on /workflows reflects what's actually happening.
      if (req.method === "GET" && this.workflowRuns && this.workflowStore) {
        if (path === "/api/workflows") {
          this.json(res, 200, { workflows: this.workflowStore.list() })
          return
        }
        if (path === "/api/workflows/runs") {
          const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 50)))
          const workflowId = url.searchParams.get("workflowId") || undefined
          this.json(res, 200, { runs: this.workflowRuns.list({ workflowId, limit }) })
          return
        }
        const runMatch = path.match(/^\/api\/workflows\/runs\/([^\/]+)$/)
        if (runMatch) {
          const run = this.workflowRuns.get(decodeURIComponent(runMatch[1]))
          if (!run) { this.json(res, 404, { error: "run not found" }); return }
          this.json(res, 200, { run })
          return
        }
      }
      // POST /api/workflows/editor/chat — author chat dispatched to an agent.
      //
      // Body: { messages: [{role, content}], currentWorkflow?, agentId?, context? }
      // Returns: { reply, workflow? | null, error? }
      //
      // The endpoint packs the full V2 schema + environment (available
      // agents, actors, roles, channels, existing workflows) into the
      // agent's prompt so a generic agent with no special training can
      // still produce a valid workflow JSON.
      if (req.method === "POST" && path === "/api/workflows/editor/chat" && this.workflowDispatcher) {
        let body: any
        try { body = await readJsonBody(req) } catch (e: any) {
          this.json(res, 400, { error: "invalid JSON body", message: e.message }); return
        }
        const messages = Array.isArray(body?.messages) ? body.messages as Array<{ role: string; content: string }> : []
        if (!messages.length) { this.json(res, 400, { error: "messages array required" }); return }
        const normMessages = messages
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
        if (!normMessages.length) { this.json(res, 400, { error: "messages must contain at least one {role: 'user'|'assistant', content}" }); return }

        const agentId = typeof body?.agentId === "string" && body.agentId
          ? body.agentId
          : (process.env.AGENTX_WORKFLOW_AUTHOR_AGENT || this.registry.list()[0]?.id)
        if (!agentId) { this.json(res, 503, { error: "no authoring agent available — register an agent or set AGENTX_WORKFLOW_AUTHOR_AGENT" }); return }

        const { buildWorkflowAuthorPrompt, extractWorkflowJson } = await import("@/workflows/editor-chat")
        const availableChannels = Object.keys(this.workflowDispatcher["channels"] as Record<string, unknown>).sort()
        const availableAgents = this.registry.list().map((a) => ({ id: a.id, description: a.name }))
        const prompt = buildWorkflowAuthorPrompt({
          messages: normMessages,
          store: this.workflowStore!,
          actors: this.workflowDispatcher.actors,
          availableAgents,
          availableChannels,
          currentWorkflow: body?.currentWorkflow,
        })
        try {
          const resp = await this.registry.execute({
            agentId,
            message: prompt,
            context: { channel: "workflow-editor", chatId: "editor", sender: "editor" } as any,
          })
          if (resp.error) { this.json(res, 502, { error: resp.error, agentId }); return }
          const reply = resp.content ?? ""
          const workflow = extractWorkflowJson(reply)
          this.json(res, 200, { reply, workflow, agentId })
        } catch (e: any) {
          this.json(res, 500, { error: "agent execute failed", message: e.message })
        }
        return
      }

      // POST /api/workflows/signal/:name — manual signal emission.
      if (req.method === "POST" && path.startsWith("/api/workflows/signal/") && this.workflowDispatcher) {
        const name = decodeURIComponent(path.replace(/^\/api\/workflows\/signal\//, ""))
        if (!name) { this.json(res, 400, { error: "signal name required" }); return }
        let body: any
        try { body = await readJsonBody(req) } catch (e: any) {
          this.json(res, 400, { error: "invalid JSON body", message: e.message }); return
        }
        const emission = this.workflowDispatcher.emitSignal({
          name,
          scope: body?.scope,
          workflowId: body?.workflowId,
          payload: body?.payload,
        })
        this.json(res, 200, { ok: true, emission })
        return
      }
      // /inbox — per-actor task list page. Static HTML, fetches the task
      // API above via same-origin.
      if (req.method === "GET" && path === "/inbox") {
        const { renderInboxPage } = await import("./ui/pages/inbox")
        const qs = url.searchParams
        const html = renderInboxPage({ actor: qs.get("actor") || undefined })
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(html)
        return
      }
      // /processes — composition-tree + SLA view of runs.
      if (req.method === "GET" && path === "/processes") {
        const { renderProcessesPage } = await import("./ui/pages/processes")
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(renderProcessesPage({}))
        return
      }
      // GET /t/:taskId/:action — one-click task submission from chat
      // clients (Telegram inline-keyboard URL buttons). Submits with
      // empty values → validator fills defaults. Only works for forms
      // whose required fields have defaults (or none at all).
      const oneClick = req.method === "GET" && path.match(/^\/t\/([^\/]+)\/(primary|secondary)$/)
      if (oneClick && this.workflowDispatcher) {
        const taskId = decodeURIComponent(oneClick[1])
        const action = oneClick[2] as "primary" | "secondary"
        const actor = url.searchParams.get("actor") || "anonymous"
        const result = await this.workflowDispatcher.submitTask(taskId, { action, values: {} }, actor)
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" })
        if (result.ok) {
          res.end(`<!doctype html><meta charset=utf-8><title>Submitted</title>
<body style="font-family:system-ui;max-width:520px;margin:48px auto;padding:0 16px;text-align:center">
<h1 style="color:#27ae60">✓ Submitted</h1>
<p>Your <strong>${action === "primary" ? "approval" : "rejection"}</strong> has been recorded. You can close this tab.</p>
<p style="color:#888;font-size:13px">Run <code>${result.runId}</code></p>
</body>`)
        } else {
          res.end(`<!doctype html><meta charset=utf-8><title>Submit failed</title>
<body style="font-family:system-ui;max-width:520px;margin:48px auto;padding:0 16px;text-align:center">
<h1 style="color:#c0392b">✗ ${result.error}</h1>
${Array.isArray(result.fieldErrors) && result.fieldErrors.length ? `<p>This task has required fields. Please open the <a href="/inbox?actor=${encodeURIComponent(actor)}">inbox</a> instead.</p>` : ""}
</body>`)
        }
        return
      }

      // Static browser call page.
      if (req.method === "GET" && path === "/call") {
        this.serveCallPage(res)
        return
      }

      // Dynamic routes (before static switch)
      if (req.method === "POST" && path.startsWith("/webhook/")) {
        // GitHub channel adapter: intercept webhooks with X-GitHub-Event header
        // when the GitHub channel is enabled — routes internally by repo.
        if (this.github && req.headers["x-github-event"]) {
          const body = await new Promise<string>((resolve) => {
            let data = ""
            req.on("data", (chunk: Buffer) => (data += chunk.toString()))
            req.on("end", () => resolve(data))
            req.on("error", () => resolve(""))
          })
          let parsed: Record<string, unknown>
          try {
            // GitHub may send as application/json or application/x-www-form-urlencoded
            const contentType = req.headers["content-type"] || ""
            if (contentType.includes("form-urlencoded") && body.startsWith("payload=")) {
              parsed = JSON.parse(decodeURIComponent(body.slice(8)))
            } else {
              parsed = body ? JSON.parse(body) : {}
            }
          } catch { parsed = {} }
          this.log(`[github] webhook body keys: ${Object.keys(parsed).slice(0, 5).join(", ")} | repo: ${(parsed.repository as any)?.full_name || "MISSING"}`)
          // Respond immediately (GitHub has a 10s timeout)
          res.writeHead(202, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true, channel: "github", status: "accepted" }))
          // Process asynchronously
          this.github.handleWebhook(
            req.headers as Record<string, string | string[] | undefined>,
            parsed,
            body,  // raw body for signature verification
          ).catch(e => this.log(`[github] webhook handler error: ${(e as Error).message}`))
          return
        }
        await this.webhooks.handle(req, res, path)
        return
      }

      // SSE stream for a single running task — drives the dashboard modal.
      // GET /agents/:agentId/tasks/:taskId/stream
      const taskStreamMatch = req.method === "GET" && path.match(/^\/agents\/([^/]+)\/tasks\/([^/]+)\/stream$/)
      if (taskStreamMatch) {
        this.handleTaskStream(req, res, taskStreamMatch[1], taskStreamMatch[2])
        return
      }

      // Persisted task history (for the dashboard "Recent activities" panel).
      // GET /agents/:agentId/tasks?limit=N  → list of summaries (newest first)
      // GET /agents/:agentId/tasks/:taskId  → one full record (transcript + response)
      const taskHistoryListMatch = req.method === "GET" && path.match(/^\/agents\/([^/]+)\/tasks$/)
      if (taskHistoryListMatch) {
        const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "50", 10) || 50))
        this.json(res, 200, this.registry.listTaskHistory(taskHistoryListMatch[1], limit))
        return
      }
      const taskRecordMatch = req.method === "GET" && path.match(/^\/agents\/([^/]+)\/tasks\/([^/]+)$/)
      if (taskRecordMatch) {
        const rec = this.registry.getTaskRecord(taskRecordMatch[1], taskRecordMatch[2])
        if (!rec) { this.json(res, 404, { error: "not found" }); return }
        this.json(res, 200, rec)
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

        case "GET /whatsapp/state": {
          const { getWhatsAppState } = await import("./whatsapp-state")
          this.json(res, 200, getWhatsAppState())
          break
        }

        case "GET /whatsapp/qr.svg": {
          const { getWhatsAppState } = await import("./whatsapp-state")
          const s = getWhatsAppState()
          if (!s.qr) { res.writeHead(204, { "Cache-Control": "no-store" }); res.end(); break }
          try {
            // @ts-ignore — qrcode has no shipped types
            const mod = await import("qrcode")
            const QRCode: any = (mod as any).default || mod
            const svg: string = await QRCode.toString(s.qr, { type: "svg", errorCorrectionLevel: "L", margin: 1, color: { dark: "#000", light: "#fff" } })
            res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" })
            res.end(svg)
          } catch (e: any) {
            res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
            res.end("qrcode package not installed or failed: " + (e?.message || "unknown"))
          }
          break
        }

        case "GET /whatsapp/chats": {
          const wa = this.router.getChannel("whatsapp") as WhatsAppAdapter | undefined
          if (!wa) { this.json(res, 503, { error: "WhatsApp channel not enabled" }); break }
          this.json(res, 200, { chats: wa.listChats() })
          break
        }

        case "GET /whatsapp/contacts": {
          const wa = this.router.getChannel("whatsapp") as WhatsAppAdapter | undefined
          if (!wa) { this.json(res, 503, { error: "WhatsApp channel not enabled" }); break }
          this.json(res, 200, { contacts: wa.listContacts() })
          break
        }

        case "POST /whatsapp/ingest": {
          const wa = this.router.getChannel("whatsapp") as WhatsAppAdapter | undefined
          if (!wa) { this.json(res, 503, { error: "WhatsApp channel not enabled" }); break }
          const body = await readBody(req)
          const cfg = this.config.channels.whatsapp.ingest
          if (!cfg.enabled && !body.force) {
            this.json(res, 400, { error: "channels.whatsapp.ingest.enabled is false. Set it to true in agentx.json or pass {\"force\": true}." })
            break
          }
          const agentId = (typeof body.agent === "string" && body.agent)
            || this.config.channels.whatsapp.defaultAgent
            || this.config.node.defaultAgent
          if (!agentId) {
            this.json(res, 400, { error: "No agent to own the entries. Pass {agent: '...'} or set channels.whatsapp.defaultAgent." })
            break
          }
          const dryRun = !!body.dryRun
          const { runSweep } = await import("@/wiki/ingest-whatsapp")
          const store = this.registry.getWikiHub().getAgentWiki(agentId)
          // Support per-chat CLI commands (ingest-contact / ingest-chat):
          // narrow the allowlist to the single JID and optionally override
          // the ingest mode for this pass only. Leaves the persistent
          // allowlist in agentx.json untouched.
          let effectiveCfg = cfg
          if (typeof body.onlyJid === "string") {
            const jid = body.onlyJid as string
            const isGroup = jid.endsWith("@g.us")
            const forced: "metadata-only" | "messages" | undefined =
              body.forceMode === "metadata-only" || body.forceMode === "messages"
                ? body.forceMode
                : undefined
            effectiveCfg = {
              ...cfg,
              // Ignore the master enabled flag when a specific JID was named
              // via the CLI — operator has explicitly pointed at this one.
              enabled: true,
              mode: forced ?? cfg.mode,
              // Narrow scope to exactly this JID regardless of existing lists.
              allowContacts: isGroup || body.onlyKind === "group" ? [] : [jid],
              allowGroups: isGroup || body.onlyKind === "group" ? [jid] : [],
              denyContacts: [],
              denyGroups: [],
            }
          }
          const report = await runSweep({
            source: wa,
            store,
            config: effectiveCfg,
            agentId,
            dryRun,
          })
          this.json(res, 200, report)
          break
        }

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

        case "POST /github/send-comment": {
          // Forwarded from a mesh peer: post a comment using the local GitHub token.
          const body = await readBody(req)
          const { repo, issueNumber, agentId, text } = body as any
          // Resolve token: per-agent tokenFile, per-agent token, or global
          const ghConfig = this.config.channels.github
          const mappings = ghConfig?.agentMappings || []
          const mapping = mappings.find((m: any) => m.agentId === agentId)
          let token: string | undefined
          if (mapping?.tokenFile) {
            try { token = readFileSync(mapping.tokenFile, "utf-8").trim().split("\n")[0].trim() } catch { /* */ }
          }
          token = token || mapping?.token
          if (!token && ghConfig?.tokenFile) {
            try { token = readFileSync(ghConfig.tokenFile, "utf-8").trim().split("\n")[0].trim() } catch { /* */ }
          }
          token = token || ghConfig?.token
          if (!token) {
            this.json(res, 404, { error: "no github token for agent", debug: { agentId, hasMapping: !!mapping } })
            break
          }
          const ep = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`
          try {
            const ghRes = await fetch(ep, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": "AgentX" },
              body: JSON.stringify({ body: text }),
            })
            const respBody = await ghRes.text().catch(() => "")
            let commentId = ""
            try { commentId = String((JSON.parse(respBody) as any).id || "") } catch { /* */ }
            this.log(`[github/send-comment] agent="${agentId}" -> POST ${ep} : ${ghRes.status} commentId=${commentId || "?"}`)
            this.json(res, 200, { ok: ghRes.ok, status: ghRes.status, commentId })
          } catch (e: any) {
            this.log(`[github/send-comment] FETCH ERROR: ${e.message}`)
            this.json(res, 500, { error: e.message })
          }
          break
        }

        case "POST /github/react": {
          // Forwarded from a mesh peer: react with 👀 on a GitHub comment.
          const body = await readBody(req)
          const { repo, commentId, agentId } = body as any
          const ghConfig = this.config.channels.github
          const mappings = ghConfig?.agentMappings || []
          const mapping = mappings.find((m: any) => m.agentId === agentId)
          let token: string | undefined
          if (mapping?.tokenFile) {
            try { token = readFileSync(mapping.tokenFile, "utf-8").trim().split("\n")[0].trim() } catch { /* */ }
          }
          token = token || mapping?.token
          if (!token && ghConfig?.tokenFile) {
            try { token = readFileSync(ghConfig.tokenFile, "utf-8").trim().split("\n")[0].trim() } catch { /* */ }
          }
          token = token || ghConfig?.token
          if (!token) {
            this.json(res, 404, { error: "no github token for agent" })
            break
          }
          const ep = `https://api.github.com/repos/${repo}/issues/comments/${commentId}/reactions`
          try {
            const ghRes = await fetch(ep, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": "AgentX" },
              body: JSON.stringify({ content: "eyes" }),
            })
            this.log(`[github/react] agent="${agentId}" -> POST ${ep} : ${ghRes.status}`)
            this.json(res, 200, { ok: ghRes.ok, status: ghRes.status })
          } catch (e: any) {
            this.log(`[github/react] FETCH ERROR: ${e.message}`)
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

        case "POST /recall": {
          // Conversation recall — reads stored sessions for a given agent
          // (optionally narrowed to a channel/chatId) and returns turns
          // newest-first with a cursor for pagination. Read-only.
          const body = await readBody(req)
          if (!body.agent) {
            this.json(res, 400, { error: "Required: agent (id of the agent whose sessions to recall)" })
            break
          }
          try {
            const result = this.registry.getSessionStore().recallTurns({
              agentId: String(body.agent),
              channel: body.channel ? String(body.channel) : undefined,
              chatId: body.chatId ? String(body.chatId) : undefined,
              before: body.before ? String(body.before) : undefined,
              after: body.after ? String(body.after) : undefined,
              lookbackDays: typeof body.lookbackDays === "number" ? body.lookbackDays : undefined,
              limit: typeof body.limit === "number" ? body.limit : undefined,
              query: body.query ? String(body.query) : undefined,
              participants: Array.isArray(body.participants)
                ? body.participants.map((p: unknown) => String(p))
                : undefined,
            })
            this.json(res, 200, result)
          } catch (e: any) {
            this.json(res, 500, { error: e?.message || String(e) })
          }
          break
        }

        case "POST /chat/recent": {
          // Cross-agent view of a chat. Returns the most recent messages
          // across EVERY agent's session for the given (channel, chatId)
          // — sorted oldest-first so the caller reads it like a transcript.
          // Use cases:
          //   - Agent introspection ("what was just said in this chat?")
          //   - Multi-agent groups where one agent needs to see what another
          //     replied without going through A2A indirection (today's
          //     cx→devops→marketing speculation thread is the failure mode
          //     this fixes).
          // Bounded by sinceISO (default: last 24h) and limit (default: 30,
          // max 200) so a long-running group can't blow up an agent's prompt.
          const body = await readBody(req)
          if (!body.channel || !body.chatId) {
            this.json(res, 400, { error: "Required: channel, chatId" })
            break
          }
          try {
            const messages = this.registry.getSessionStore().recentByChatId({
              channel: String(body.channel),
              chatId: String(body.chatId),
              sinceISO: typeof body.sinceISO === "string" ? body.sinceISO : undefined,
              limit: typeof body.limit === "number" ? body.limit : undefined,
            })
            this.json(res, 200, { messages, count: messages.length })
          } catch (e: any) {
            this.json(res, 500, { error: e?.message || String(e) })
          }
          break
        }

        case "POST /send/agent": {
          // Explicit A2A send: route to another agent via mesh (or local
          // dispatch when the target lives on this daemon). This is the
          // deterministic path for "agent A asks agent B to do X" — no
          // contact-directory fallback, no name fuzzy-matching. Caller
          // must pass an exact agentId. Returns the resulting task id /
          // remote message id when the mesh accepts the task.
          const body = await readBody(req)
          if (!body.agentId || !body.text) {
            this.json(res, 400, { error: "Required: agentId, text" })
            break
          }
          const targetAgent = String(body.agentId)
          const text = String(body.text)
          // Local agent? Dispatch directly through the registry.
          const localDef = this.registry.getAgent(targetAgent)
          if (localDef) {
            try {
              const senderAgentId = body.senderAgentId ? String(body.senderAgentId) : undefined
              const response = await this.registry.execute({
                agentId: targetAgent,
                message: text,
                context: { channel: "a2a", sender: senderAgentId ? `agent:${senderAgentId}` : "agent", chatId: senderAgentId || "a2a" },
              })
              this.json(res, response.error ? 500 : 200, { ok: !response.error, content: response.content, error: response.error })
            } catch (e: any) {
              this.json(res, 500, { error: e.message })
            }
            break
          }
          // Remote agent? Find the mesh peer that advertises this agent.
          if (!this.mesh) {
            this.json(res, 400, { error: `Unknown agent "${targetAgent}" — mesh disabled, no remote lookup possible` })
            break
          }
          const directory = this.mesh.directory()
          const peer = directory.find((p) => p.healthy && p.skills.some((s) => s.id === targetAgent))
          if (!peer) {
            const known = [
              ...Object.keys(this.config.agents),
              ...directory.flatMap((p) => p.skills.map((s) => s.id)),
            ]
            this.json(res, 404, { error: `Unknown agent "${targetAgent}"`, known })
            break
          }
          try {
            const senderAgentId = body.senderAgentId ? String(body.senderAgentId) : undefined
            const messageId = await this.mesh.sendTask(peer.peer, text, targetAgent, { senderAgentId })
            this.json(res, 200, { ok: true, messageId, peer: peer.peer })
          } catch (e: any) {
            this.json(res, 500, { error: e.message, peer: peer.peer })
          }
          break
        }

        case "POST /send/contact": {
          // Resolve a free-form contact name through the contact directory,
          // pick a channel address, then dispatch via the regular
          // sendOutbound path. Refuses on miss/ambiguous/fuzzy(no-confirm)
          // so the caller can ask the user to disambiguate. Distinct from
          // /send (which requires a chatId) and /send/agent (which uses
          // mesh), so route_traces records why each path was taken.
          const body = await readBody(req)
          if (!body.contactName || !body.text) {
            this.json(res, 400, { error: "Required: contactName, text" })
            break
          }
          const name = String(body.contactName)
          const text = String(body.text)
          const preferredChannel = body.channel ? String(body.channel) : undefined
          const confirmed = body.confirmed === true
          const result = this.contacts.resolve(name)

          if (result.kind === "miss") {
            this.json(res, 404, { error: `No contact matches "${name}"`, hint: "Add the contact to .agentx/contacts.json and POST /reload." })
            break
          }
          if (result.kind === "ambiguous") {
            this.json(res, 409, { error: "ambiguous", candidates: result.candidates.map((c) => ({ id: c.id, name: c.name, channels: Object.keys(c.channels) })) })
            break
          }
          if (result.kind === "fuzzy" && !confirmed) {
            // Refuse silent fuzzy match — caller (the LLM) must confirm.
            // Returns the candidate so the agent can ask the user "did you mean X?".
            this.json(res, 409, {
              error: "fuzzy-match-needs-confirmation",
              candidate: { id: result.contact.id, name: result.contact.name, channels: Object.keys(result.contact.channels) },
              confidence: result.confidence,
              hint: "Re-call with confirmed:true once the user has confirmed this is the intended recipient.",
            })
            break
          }
          // Cross-channel collision check: if the name also resolves to a
          // registered local agent, surface ambiguity rather than silently
          // pick the contact. Mesh peers handled the same way.
          const collidesWithLocalAgent = !!this.registry.getAgent(name)
          const collidesWithMeshAgent = this.mesh?.directory()?.some((p) => p.skills.some((s) => s.id.toLowerCase() === name.toLowerCase()))
          if (collidesWithLocalAgent || collidesWithMeshAgent) {
            this.json(res, 409, {
              error: "ambiguous",
              hint: `"${name}" resolves to BOTH a contact (id=${result.contact.id}) and an agent. Use /send/agent for the agent, or pass contactId="${result.contact.id}" to /send/contact for the contact.`,
            })
            break
          }
          const picked = this.contacts.pickChannel(result.contact, preferredChannel)
          if (!picked) {
            this.json(res, 400, { error: `Contact "${result.contact.id}" has no channels configured` })
            break
          }
          if (preferredChannel && picked.channel !== preferredChannel) {
            this.json(res, 400, { error: `Contact "${result.contact.id}" has no "${preferredChannel}" channel`, available: Object.keys(result.contact.channels) })
            break
          }
          try {
            const messageId = await this.router.sendOutbound({
              channel: picked.channel,
              chatId: picked.address,
              text,
              agentId: body.agentId as string | undefined,
              accountId: body.accountId as string | undefined,
            })
            this.json(res, 200, { ok: true, messageId: messageId || null, contactId: result.contact.id, channel: picked.channel })
          } catch (e: any) {
            this.json(res, 400, { error: e.message })
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
          // A2A sender identity — when present, must resolve to an agent on
          // the calling peer. Log-warn (not enforce) for one release so
          // older mesh peers can roll out the field before we reject. The
          // shape "no body.context" is what classic A2A calls look like;
          // human-facing /task callers (CLI, dashboard) always set
          // context.channel, so the warning targets only mesh traffic.
          const senderAgentId = typeof body.senderAgentId === "string" ? body.senderAgentId : undefined
          const looksLikeA2A = !body.context
          if (looksLikeA2A && !senderAgentId) {
            this.log(`[a2a] /task accepted without senderAgentId for agent="${agentId}" from ${(req.socket?.remoteAddress) || "unknown"} — caller should upgrade. Required in next release.`)
          }
          // Per-task context strategy override. When absent, registry falls
          // back to config.session.contextStrategy. Used by the bench
          // harness to A/B the same request under "layered" vs "planner"
          // without a daemon reload.
          const contextStrategy =
            body.contextStrategy === "layered" || body.contextStrategy === "planner"
              ? body.contextStrategy
              : undefined
          // No-op onDelta enables stream-json runtime mode so the dashboard
          // task modal can see tool calls + tool results live. The caller still
          // awaits the final response — they don't see deltas, just the result.
          const response = await this.registry.execute(
            {
              agentId,
              message: body.message as string,
              context: body.context as any,
              contextStrategy,
            },
            () => {},
          )
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

        // Browser → daemon → remote peer
        case "POST /webrtc/signal/out": {
          if (!this.webrtc) {
            this.json(res, 404, { error: "WebRTC signaling not enabled" })
            return
          }
          const body = await readBody(req)
          const signal = body as unknown as WebRtcSignal
          if (!signal.kind || !signal.callId || !signal.from || !signal.to) {
            this.json(res, 400, { error: "Missing: kind, callId, from, to" })
            return
          }
          const result = await this.webrtc.handleOutgoing(signal)
          this.json(res, result.ok ? 200 : 400, result)
          break
        }

        // Remote peer → daemon → local browser (SSE fan-out).
        // Called by `A2AMesh.sendSignal()` on the sending peer.
        case "POST /webrtc/signal": {
          if (!this.webrtc) {
            this.json(res, 404, { error: "WebRTC signaling not enabled" })
            return
          }
          const body = await readBody(req)
          const signal = body as unknown as WebRtcSignal
          if (!signal.kind || !signal.callId || !signal.from || !signal.to) {
            this.json(res, 400, { error: "Missing: kind, callId, from, to" })
            return
          }
          const result = this.webrtc.handleIncoming(signal)
          this.json(res, result.ok ? 200 : 400, result)
          break
        }

        // Browser asks the local daemon to spawn a bot peer for this call.
        case "POST /webrtc/bot/invite": {
          if (!this.botManager) {
            this.json(res, 404, { error: "WebRTC bot not enabled (channels.webrtc.bot.enabled=false)" })
            return
          }
          const body = await readBody(req)
          const callId = body.callId as string | undefined
          const target = body.target as string | undefined
          const agentId = (body.agentId as string | undefined) || this.config.channels.webrtc?.bot.defaultAgentId
          if (!callId || !target || !agentId) {
            this.json(res, 400, { error: "Missing: callId, target, agentId (or defaultAgentId in config)" })
            return
          }
          const result = await this.botManager.invite({ callId, target, agentId })
          this.json(res, result.ok ? 200 : 500, result)
          break
        }

        case "GET /webrtc/bots": {
          if (!this.botManager) {
            this.json(res, 404, { error: "WebRTC bot not enabled" })
            return
          }
          this.json(res, 200, { active: this.botManager.active() })
          break
        }

        case "GET /webrtc/config": {
          const wrtc = this.config.channels.webrtc
          if (!wrtc?.enabled) {
            this.json(res, 404, { error: "WebRTC signaling not enabled" })
            return
          }
          this.json(res, 200, {
            localName: this.config.node.name,
            iceServers: [
              ...wrtc.stunServers.map(urls => ({ urls })),
              ...wrtc.turnServers,
            ],
            peers: this.mesh?.directory().map(p => ({ name: p.peer, healthy: p.healthy })) || [],
          })
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
            // Channels this node hosts. Used by mesh peers to route
            // workflow `action.send` calls back to the originating channel
            // when the workflow runs on a different node than the channel
            // adapter (e.g. workflow on macbook, whatsapp on clawd-server).
            channels: this.router.getChannelNames(),
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

        // --- Graph API (read-only, for mesh sync) ---

        case "GET /graph/schema": {
          const store = this.registry.getGraphStore()
          if (!store) { this.json(res, 404, { error: "graph disabled on this node" }); break }
          this.json(res, 200, {
            nodeId: this.config.node.id,
            schema: store.loadSchema(),
          })
          break
        }

        case "GET /graph/nodes": {
          const store = this.registry.getGraphStore()
          if (!store) { this.json(res, 404, { error: "graph disabled on this node" }); break }
          this.json(res, 200, {
            nodeId: this.config.node.id,
            ...store.loadNodes(),
          })
          break
        }

        case "GET /graph/classifications": {
          const store = this.registry.getGraphStore()
          if (!store) { this.json(res, 404, { error: "graph disabled on this node" }); break }
          const status = (url.searchParams.get("status") || "approved") as "pending" | "approved" | "rejected"
          const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get("limit") || "200", 10) || 200))
          const items = store.listByStatus(status, limit)
          this.json(res, 200, {
            nodeId: this.config.node.id,
            status,
            count: items.length,
            classifications: items,
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
              "GET  /graph/schema",
              "GET  /graph/nodes",
              "GET  /graph/classifications[?status=approved|pending|rejected&limit=N]",
              "POST /task { agent, message, context? }",
              "POST /mesh/task { peer, message }",
              "POST /webhook/:agentId[/:source]  — webhook callback",
              "POST /reload  — re-read agentx.json (hot-swaps crons)",
              "GET  /.well-known/agent-card.json",
              "GET  /call  — browser UI for P2P A/V calls (requires channels.webrtc.enabled)",
              "GET  /webrtc/config  — ICE servers + peer directory for the call page",
              "GET  /webrtc/events?callId=&as=  — SSE stream of signaling events",
              "POST /webrtc/signal/out  — browser-originated signal, forwarded to remote peer",
              "POST /webrtc/signal  — remote-peer-originated signal, fanned out to local browser",
              "POST /webrtc/bot/invite { callId, target, agentId }  — spawn a transcribing bot peer for a call",
              "GET  /webrtc/bots  — active bot sessions",
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

  /** Boot-time: install the `remember` skill into every agent workspace
   *  that doesn't already have it, and sync each agent's existing memory
   *  into <workspace>/CLAUDE.md + .agentx-memory.md. Idempotent — safe to
   *  run on every daemon start. Write-if-absent for the skill, sentinel-
   *  replace for CLAUDE.md, so operator edits survive. */
  private installAgentMemorySurface(): void {
    for (const agent of this.registry.list()) {
      const ws = agent.workspace
      if (!ws || !existsSync(ws)) continue
      try {
        const skillsDir = resolve(ws, ".claude", "skills")
        mkdirSync(skillsDir, { recursive: true })
        const skillPath = resolve(skillsDir, REMEMBER_SKILL_FILENAME)
        if (!existsSync(skillPath)) {
          writeFileSync(skillPath, REMEMBER_SKILL_BODY)
          this.log(`  memory-skill: installed remember.md → ${agent.id}`)
        }
        // Always re-sync: rewrites .agentx-memory.md and the CLAUDE.md
        // sentinel block from whatever is currently on disk.
        this.agentMemory.syncToWorkspace(agent.id, ws)
      } catch (e: any) {
        this.log(`  memory-skill: ${agent.id} install failed — ${e?.message ?? e}`)
      }
    }
  }

  /** Boot-time: sync each agent's `mcp` config block to
   *  <workspace>/.mcp.json. Mirrors installAgentMemorySurface — same
   *  ownership semantics, marker-based to preserve operator edits. */
  private installAgentMcpConfig(): void {
    for (const [agentId, def] of Object.entries(this.config.agents)) {
      const ws = def.workspace
      if (!ws || !existsSync(ws)) continue
      const mcp = ((def as any).mcp ?? {}) as McpServerMap
      try {
        const result = syncMcpToWorkspace(ws, mcp)
        switch (result) {
          case "installed":
            this.log(`  mcp: installed ${Object.keys(mcp).length} server(s) → ${agentId}`)
            break
          case "updated":
            this.log(`  mcp: updated .mcp.json (${Object.keys(mcp).length} server(s)) → ${agentId}`)
            break
          case "removed":
            this.log(`  mcp: removed managed .mcp.json (config now empty) → ${agentId}`)
            break
          case "skipped-operator-owned":
            // Only worth surfacing when there's a config the operator
            // is silently overriding. Otherwise stay quiet.
            if (Object.keys(mcp).length > 0) {
              this.log(`  mcp: ${agentId} has operator-owned .mcp.json — skipping (delete file or marker to let agentx manage)`)
            }
            break
          case "noop":
            break
        }
      } catch (e: any) {
        this.log(`  mcp: ${agentId} install failed — ${e?.message ?? e}`)
      }
    }
  }

  /** Look up an agent's workspace from the live registry. Returns null
   *  for agents the daemon doesn't know about (e.g., a stale memory
   *  entry for a since-removed agent). */
  private workspaceFor(agentId: string): string | null {
    for (const a of this.registry.list()) if (a.id === agentId) return a.workspace
    return null
  }

  /** Agent-memory HTTP surface. Agents call this from inside a Claude
   *  Code session via `Bash` + `curl` — see the `remember` skill. The
   *  heavy lifting is in `AgentRegistry.agentMemory` (AgentMemory); this
   *  is a thin JSON wrapper that validates + delegates. */
  private async handleMemoryApi(
    req: IncomingMessage, res: ServerResponse, path: string, url: URL,
  ): Promise<boolean> {
    const mem = this.agentMemory

    // GET /api/memory?agent=<id>
    if (req.method === "GET" && path === "/api/memory") {
      const agent = url.searchParams.get("agent") || ""
      if (!agent) { this.json(res, 400, { error: "missing agent query param" }); return true }
      this.json(res, 200, { agent, memories: mem.list(agent), index: mem.indexMarkdown(agent) })
      return true
    }
    // GET /api/memory/:name?agent=<id>
    const oneMatch = req.method === "GET" && path.match(/^\/api\/memory\/([^\/?]+)$/)
    if (oneMatch) {
      const agent = url.searchParams.get("agent") || ""
      if (!agent) { this.json(res, 400, { error: "missing agent query param" }); return true }
      const rec = mem.get(agent, decodeURIComponent(oneMatch[1]))
      if (!rec) { this.json(res, 404, { error: "no such memory" }); return true }
      this.json(res, 200, { memory: rec })
      return true
    }
    // POST /api/memory — write a memory
    if (req.method === "POST" && path === "/api/memory") {
      let body: any
      try { body = await readJsonBody(req) } catch (e: any) {
        this.json(res, 400, { error: "invalid JSON body", message: e.message }); return true
      }
      const agentId = typeof body?.agentId === "string" ? body.agentId : ""
      const type    = typeof body?.type === "string" ? body.type : ""
      const name    = typeof body?.name === "string" ? body.name : ""
      const description = typeof body?.description === "string" ? body.description : ""
      const newBody = typeof body?.body === "string" ? body.body : ""
      const append  = body?.append === true
      if (!agentId || !type || !name || !description || !newBody) {
        this.json(res, 400, { error: "required fields: agentId, type, name, description, body" })
        return true
      }
      try {
        let finalBody = newBody
        if (append) {
          const existing = mem.get(agentId, name)
          if (existing) finalBody = `${existing.body.trimEnd()}\n\n${newBody.trim()}`
        }
        const rec = mem.save({ agentId, type: type as any, name, description, body: finalBody })
        const ws = this.workspaceFor(agentId)
        if (ws) { try { mem.syncToWorkspace(agentId, ws) } catch { /* best effort */ } }
        this.json(res, 200, { ok: true, memory: rec, syncedToWorkspace: !!ws })
      } catch (e: any) {
        this.json(res, 400, { error: e?.message || "save failed" })
      }
      return true
    }
    // DELETE /api/memory/:name?agent=<id>
    const delMatch = req.method === "DELETE" && path.match(/^\/api\/memory\/([^\/?]+)$/)
    if (delMatch) {
      const agent = url.searchParams.get("agent") || ""
      if (!agent) { this.json(res, 400, { error: "missing agent query param" }); return true }
      const ok = mem.remove(agent, decodeURIComponent(delMatch[1]))
      if (!ok) { this.json(res, 404, { error: "no such memory" }); return true }
      const ws = this.workspaceFor(agent)
      if (ws) { try { mem.syncToWorkspace(agent, ws) } catch { /* best effort */ } }
      this.json(res, 200, { ok: true })
      return true
    }
    return false
  }

  /** Mesh receiver for forwarded workflow events. Peers POST the same
   *  payload shape the MeshForwarder sends. Enforces that the run is
   *  actually home'd here before acting — protects against routing loops. */
  private async handleTaskApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const d = this.workflowDispatcher
    if (!d) return false
    const { formSubmissionSchema } = await import("@/forms/types")

    // GET /api/workflows/tasks[?actor=<id>]
    if (req.method === "GET" && (path === "/api/workflows/tasks" || path.startsWith("/api/workflows/tasks?"))) {
      const url = new URL(req.url || "/", `http://_`)
      const actor = url.searchParams.get("actor") || undefined
      const tasks = actor ? d.tasks.listForActor(actor) : d.tasks.listOpen()
      this.json(res, 200, { tasks })
      return true
    }

    // GET /api/workflows/tasks/:id
    // POST /api/workflows/tasks/:id/submit
    const trail = path.replace(/^\/api\/workflows\/tasks/, "")
    const match = trail.match(/^\/([^\/?]+)(\/submit)?$/)
    if (!match) return false
    const taskId = decodeURIComponent(match[1])

    if (match[2]) {
      if (req.method !== "POST") { this.json(res, 405, { error: "method not allowed" }); return true }
      let body: any
      try { body = await readJsonBody(req) } catch (e: any) {
        this.json(res, 400, { error: "invalid JSON body", message: e.message }); return true
      }
      const submissionRaw = body && typeof body === "object" && "submission" in body ? (body as any).submission : body
      const parsed = formSubmissionSchema.safeParse(submissionRaw)
      if (!parsed.success) {
        this.json(res, 400, {
          error: "invalid submission",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        })
        return true
      }
      const submittedBy = typeof body?.submittedBy === "string" ? body.submittedBy : "anonymous"
      const result = await d.submitTask(taskId, parsed.data, submittedBy)
      if (!result.ok) { this.json(res, 400, { error: result.error, fieldErrors: result.fieldErrors }); return true }
      this.json(res, 200, { ok: true, runId: result.runId })
      return true
    }

    if (req.method === "GET") {
      const task = d.tasks.get(taskId)
      if (!task) { this.json(res, 404, { error: "task not found" }); return true }
      this.json(res, 200, { task })
      return true
    }
    return false
  }

  private async handleWorkflowEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.workflowDispatcher) {
      this.json(res, 503, { error: "workflow engine not enabled on this node" })
      return
    }
    let body: any
    try { body = await readJsonBody(req) } catch (e: any) {
      this.json(res, 400, { error: "invalid JSON body", message: e.message }); return
    }
    const payload = body?.payload ?? body
    const event = payload?.event
    const entityRef = payload?.entityRef
    if (!event?.id || !entityRef?.backend || !entityRef?.id) {
      this.json(res, 400, { error: "missing event or entityRef" }); return
    }

    // Two flavours arrive on this endpoint:
    //   1. kind="trigger" — a fresh trigger broadcast from a peer that
    //      observed the channel event. Trigger fields are carried in the
    //      payload itself; we dispatch with fromRemote so only opted-in
    //      workflows match.
    //   2. (legacy / transition) — a workflow-targeted forward for an active
    //      run home'd here. Reconstruct the trigger from the local workflow
    //      definition just like before.
    const kind = body?.kind
    try {
      if (kind === "trigger" && payload.trigger) {
        const fromPeer = typeof body?.fromPeer === "string" ? body.fromPeer : "unknown"
        this.log(`[workflows/mesh] received trigger from "${fromPeer}" source="${payload.trigger.source}" chat="${payload.trigger.chat ?? "*"}"`)
        const r = await this.workflowDispatcher.dispatch({
          trigger: payload.trigger,
          entityRef,
          event,
          fromRemote: { peer: fromPeer },
        })
        this.log(`[workflows/mesh] dispatched broadcast: matched=${r.claimed.length} ${r.claimed.length ? `(${r.claimed.map((w) => w.id).join(", ")})` : "[none — no workflow with mesh.allowRemote matched]"}`)
        this.json(res, 202, { ok: true, mode: "trigger-broadcast", matched: r.claimed.map((w) => w.id) })
        return
      }
      const wf = payload.workflowId ? this.workflowStore?.get(payload.workflowId) : null
      const triggerNode = wf?.nodes.find((n) => n.type.startsWith("trigger."))
      const cfg = (triggerNode?.config ?? {}) as {
        source?: string
        filter?: { project?: string; repo?: string; chat?: string; labels?: string[] }
      }
      const trigger = {
        source: String(cfg.source ?? "hook"),
        project: cfg.filter?.project,
        repo: cfg.filter?.repo,
        chat: cfg.filter?.chat,
        labels: cfg.filter?.labels,
      }
      await this.workflowDispatcher.dispatch({ trigger, entityRef, event })
      this.json(res, 202, { ok: true })
    } catch (e: any) {
      this.log(`[workflows] /workflow/event failed: ${e.message}`)
      this.json(res, 500, { error: e.message })
    }
  }

  /** Mesh-callable outbound send. A peer's workflow `action.send` invokes
   *  this when the channel lives on this node (e.g. clawd-server hosts
   *  whatsapp; macbook's workflow forwards here). Just unwraps to the local
   *  router's outbound path so all the same per-account/per-bot resolution
   *  applies. Authentication is currently the mesh token at the network
   *  edge — the endpoint trusts callers that reach it. */
  private async handleChannelSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: any
    try { body = await readJsonBody(req) } catch (e: any) {
      this.json(res, 400, { error: "invalid JSON body", message: e.message }); return
    }
    const channel = String(body?.channel ?? "")
    const chatId = String(body?.chatId ?? "")
    const text = String(body?.text ?? "")
    if (!channel || !chatId || !text) {
      this.json(res, 400, { error: "channel, chatId, and text are required" }); return
    }
    const adapter = this.router.getChannel(channel)
    if (!adapter) {
      this.json(res, 404, { error: `channel "${channel}" not hosted on this node` }); return
    }
    try {
      const messageId = await this.router.sendOutbound({
        channel,
        chatId,
        text,
        accountId: typeof body.accountId === "string" ? body.accountId : undefined,
        parseMode: typeof body.parseMode === "string" ? body.parseMode : undefined,
        replyTo: typeof body.replyTo === "string" ? body.replyTo : undefined,
      } as any)
      this.json(res, 200, { ok: true, messageId: messageId ?? null })
    } catch (e: any) {
      this.log(`[mesh] /channel/send "${channel}" failed: ${e.message}`)
      this.json(res, 500, { error: e.message })
    }
  }

  /** List chats the given channel adapter has observed. Merges local with
   *  every healthy mesh peer that hosts the channel — a channel's "true"
   *  chat list is spread across whichever nodes are actually paired
   *  (e.g. macbook has the channel enabled but WhatsApp Baileys is unpaired,
   *  while clawd-server is paired; macbook's list is empty but we still want
   *  the author to pick from clawd-server's cache). Dedup by `id`; the first
   *  source with a given id wins.
   *
   *  `sources` in the response tells the editor where the entries came from
   *  so it can show that metadata alongside. */
  private async handleChannelChats(
    res: ServerResponse,
    channel: string,
    opts: { localOnly?: boolean } = {},
  ): Promise<void> {
    const seen = new Set<string>()
    const chats: Array<{ id: string; name?: string; kind: "dm" | "group"; accountId?: string; source: string }> = []
    const sources: string[] = []
    const add = (items: Array<{ id: string; name?: string; kind: "dm" | "group"; accountId?: string }>, source: string) => {
      let added = 0
      for (const c of items) {
        if (!c.id || seen.has(c.id)) continue
        seen.add(c.id)
        chats.push({ ...c, source })
        added++
      }
      if (added > 0) sources.push(`${source}:${added}`)
    }

    // Local adapter — Telegram or WhatsApp shape (duck-typed).
    const local = this.router.getChannel(channel) as unknown as
      | { listKnownChats?: () => Array<{ id: string; name?: string; kind: "dm" | "group"; accountId?: string }>
          listChats?: () => Array<{ jid: string; name: string; isGroup: boolean }> }
      | undefined
    if (local?.listKnownChats) {
      try { add(local.listKnownChats(), "local") } catch { /* adapter still booting */ }
    } else if (local?.listChats) {
      try {
        add(local.listChats().map((c) => ({ id: c.jid, name: c.name, kind: c.isGroup ? ("group" as const) : ("dm" as const) })), "local")
      } catch { /* */ }
    }

    // Mesh peers — fan out in parallel with `?local=1` so peers only report
    // their OWN adapter's chats (no recursive fan-out back to us). Failures
    // don't block the response; a partial result is better than a timeout.
    if (!opts.localOnly && this.mesh) {
      const peers = this.mesh.directory().filter((p) => p.healthy && p.channels?.includes(channel))
      await Promise.allSettled(peers.map(async (peer) => {
        try {
          const r = await fetch(`${peer.peerUrl}/channels/${encodeURIComponent(channel)}/chats?local=1`, {
            signal: AbortSignal.timeout(5000),
          })
          if (!r.ok) return
          const body = await r.json() as { chats?: Array<{ id: string; name?: string; kind?: "dm" | "group"; accountId?: string }> }
          if (Array.isArray(body.chats)) {
            add(body.chats.map((c) => ({ id: c.id, name: c.name, kind: c.kind ?? "dm", accountId: c.accountId })), `mesh:${peer.peer}`)
          }
        } catch {
          // ignore — soft availability; we'll just return what we have
        }
      }))
    }

    this.json(res, 200, { channel, source: sources.join(", ") || "none", chats })
  }

  /** Manual run endpoint used by `agentx workflow run <id>`. Only workflows
   *  whose trigger node is `trigger.manual` are runnable here — any other
   *  source expects a live event and shouldn't race with a manual kick. */
  private async handleWorkflowManualRun(req: IncomingMessage, res: ServerResponse, workflowId: string): Promise<void> {
    if (!this.workflowDispatcher || !this.workflowStore) {
      this.json(res, 503, { error: "workflow engine not enabled on this node" })
      return
    }
    const wf = this.workflowStore.get(workflowId)
    if (!wf) { this.json(res, 404, { error: `unknown workflow "${workflowId}"` }); return }
    const triggerNode = wf.nodes.find((n) => n.type.startsWith("trigger."))
    if (!triggerNode) { this.json(res, 400, { error: `workflow "${workflowId}" has no trigger node` }); return }

    let body: any
    try { body = await readJsonBody(req) } catch { body = {} }
    const force = !!body?.force
    const payload = body?.payload || {}

    // By default we only allow running workflows whose trigger is
    // `trigger.manual` — otherwise a manual kick would race against live
    // channel events. `force: true` overrides this for testing: we
    // synthesize a trigger event with the workflow's declared source so
    // the dispatcher's filter still matches, and seed the provided payload
    // into the trigger node's output bundle. Useful when the live channel
    // is disconnected (WhatsApp not paired, Telegram 409 conflict) and
    // you just want to exercise the graph.
    if (triggerNode.type !== "trigger.manual" && !force) {
      this.json(res, 409, {
        error: `workflow "${workflowId}" trigger is "${triggerNode.type}"`,
        hint: `pass { "force": true } to fire anyway with a synthesized event (for testing)`,
      })
      return
    }

    const cfg = (triggerNode.config ?? {}) as {
      source?: string
      filter?: { project?: string; repo?: string; chat?: string; labels?: string[] }
    }
    const source = force ? String(cfg.source ?? "manual") : "manual"
    const entityId = String(payload.entityId || payload.chatId || `manual-${Date.now().toString(36)}`)
    const entityRef = {
      backend: force ? (cfg.source ? "channel" : "manual") : "manual",
      id: entityId,
    }
    const eventId = `manual:${workflowId}:${entityId}:${Date.now()}`
    try {
      const updated = await this.workflowDispatcher.dispatch({
        trigger: force
          ? {
              source,
              project: cfg.filter?.project,
              repo: cfg.filter?.repo,
              chat: cfg.filter?.chat,
              labels: cfg.filter?.labels,
            }
          : { source: "manual" },
        entityRef,
        event: { id: eventId, payload },
      })
      const runId = updated.runs[0]?.id
      this.json(res, runId ? 200 : 202, { ok: true, runId, entityRef, source, force })
    } catch (e: any) {
      this.log(`[workflows] manual run "${workflowId}" failed: ${e.message}`)
      this.json(res, 500, { error: e.message })
    }
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => { raw += chunk })
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { reject(e) }
    })
    req.on("error", reject)
  })
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

/**
 * Diff two agent-definition maps and return the list of field names that
 * would require a daemon restart to take effect. Hot-swappable fields
 * (systemPrompt, mentions, maxConcurrent, access, avatar, queueMode,
 * heartbeat, tags) are read fresh per-task so the registry.setConfig swap
 * is enough. Restart-required fields are those captured at Claude Code
 * subprocess spawn time: model, workspace, tier, permissionMode, mcpServers.
 */
function detectAgentRestartFields(
  prev: Record<string, any>,
  next: Record<string, any>,
): string[] {
  const restartFields = ["model", "workspace", "tier", "permissionMode", "mcpServers"]
  const changed = new Set<string>()
  const ids = new Set([...Object.keys(prev), ...Object.keys(next)])
  for (const id of ids) {
    const p = prev[id], n = next[id]
    if (!p || !n) { changed.add("add/remove"); continue }
    for (const f of restartFields) {
      if (JSON.stringify(p[f]) !== JSON.stringify(n[f])) {
        changed.add(`${id}.${f}`)
      }
    }
  }
  return Array.from(changed).slice(0, 6) // cap to keep summary readable
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
