import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, readdirSync } from "fs"
import { resolve } from "path"
import type { IncomingMessage, ServerResponse } from "http"
import { mutateAgentxConfig } from "./config-mutate"
import { TokenStore } from "./token-store"
import { loadDaemonConfig } from "./config"
import { listAgentFiles, readAgentFile, writeAgentFile, createAgentSkill, deleteAgentSkill } from "./file-ops"
import { getWhatsAppState } from "./whatsapp-state"
import type { TopbarPeer } from "./topbar"
import { renderAdminPage } from "./ui/pages/admin"

// --- /admin panel: form-driven management for agents, channels, crons ---
//
// Built for the business operator who opened the dashboard and wants to
// change something without editing JSON. Shares the same safe-write machinery
// as `agentx board add` and the setup wizard.
//
// Tabs:
//   - Agents:   list, add, delete
//   - Channels: Telegram accounts (add, toggle, delete)
//   - Crons:    schedules (add with plain-English timing, delete)
//   - Advanced: raw agentx.json editor with validate + backup-on-save

// ========================================================================
// HTTP entry points
// ========================================================================

export function handleAdminGet(_req: IncomingMessage, res: ServerResponse, peers: TopbarPeer[] = [], localToken?: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(renderAdminPage({ peers, localToken }))
}

export async function handleAdminConfigGet(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = readConfigRaw()
  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify(cfg))
}

export async function handleAdminApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  try {
    // Non-JSON carve-out: the WhatsApp QR rendered as SVG. Proxies to the
    // daemon process (different memory space) where the adapter actually
    // emits the QR.
    if (req.method === "GET" && path === "/api/admin/channels/whatsapp/qr.svg") {
      await proxyDaemonSvg(res, "/whatsapp/qr.svg")
      return
    }
    const body = req.method === "GET" ? undefined : await readJsonBody(req)
    const dispatch: Record<string, () => unknown> = {
      "GET /api/admin/state": () => getAdminState(),
      "POST /api/admin/agents": () => addAgent(body),
      "PATCH /api/admin/agents": () => editAgent(body),
      "DELETE /api/admin/agents": () => deleteAgent(body),
      "POST /api/admin/agents/access": () => setAgentAccess(body),
      "POST /api/admin/channels/telegram": () => addTelegramAccount(body),
      "DELETE /api/admin/channels/telegram": () => deleteTelegramAccount(body),
      "POST /api/admin/channels/telegram/toggle": () => toggleTelegram(body),
      "POST /api/admin/crons": () => addCron(body),
      "DELETE /api/admin/crons": () => deleteCron(body),
      "POST /api/admin/config/raw": () => replaceConfigRaw(body),
      "GET /api/admin/tokens": () => listTokens(),
      "POST /api/admin/tokens": () => createToken(body),
      "DELETE /api/admin/tokens": () => revokeToken(body),
      "POST /api/admin/agents/test": () => testDriveAgent(body),
      "PATCH /api/admin/channels/telegram": () => editTelegramAccount(body),
      "POST /api/admin/channels/slack": () => configureSlack(body),
      "POST /api/admin/channels/slack/toggle": () => toggleSlack(body),
      "POST /api/admin/channels/discord": () => configureDiscord(body),
      "POST /api/admin/channels/discord/toggle": () => toggleDiscord(body),
      "POST /api/admin/channels/gitlab": () => configureGitLab(body),
      "POST /api/admin/channels/gitlab/toggle": () => toggleGitLab(body),
      "GET /api/admin/channels/whatsapp/state": () => proxyDaemonJson("/whatsapp/state"),
      // WebRTC bot history — active calls + ring buffer of recently-completed
      // sessions. Lives on the daemon (BotManager owns it); the dashboard
      // proxies the read-only view here.
      "GET /api/admin/channels/webrtc/history": () => proxyDaemonJson("/webrtc/history"),
      // Action registry — list/upsert/delete + on-demand run.
      "POST /api/admin/actions":   () => upsertAction(body),
      "DELETE /api/admin/actions": () => deleteAction(body),
      "POST /api/admin/actions/run": () => runActionFromAdmin(body),
      "GET /api/admin/channels/whatsapp/chats": () => proxyDaemonJson("/whatsapp/chats"),
      "GET /api/admin/channels/whatsapp/contacts": () => proxyDaemonJson("/whatsapp/contacts"),
      "POST /api/admin/channels/whatsapp/ingest": () => proxyDaemonPostJson("/whatsapp/ingest", body),
      "POST /api/admin/crons/preview": () => previewCron(body),
      "POST /api/admin/webhooks": () => addWebhook(body),
      "PATCH /api/admin/webhooks": () => editWebhook(body),
      "DELETE /api/admin/webhooks": () => deleteWebhook(body),
      "POST /api/admin/mesh/peers": () => addMeshPeer(body),
      "DELETE /api/admin/mesh/peers": () => deleteMeshPeer(body),
      "POST /api/admin/mesh/toggle": () => toggleMesh(body),
      "GET /api/admin/files": () => listFilesForAgent(req),
      "GET /api/admin/files/read": () => readFileForAgent(req),
      "PUT /api/admin/files": () => writeFileForAgent(body),
      "POST /api/admin/files/skill": () => addSkillForAgent(body),
      "DELETE /api/admin/files/skill": () => removeSkillForAgent(body),
      // Actors / roles — mirrors `agentx actor` + `agentx role` CLI.
      "POST /api/admin/actors":   () => upsertActor(body),
      "DELETE /api/admin/actors": () => deleteActorById(body),
      "POST /api/admin/roles":    () => upsertRole(body),
      "DELETE /api/admin/roles":  () => deleteRoleById(body),
      "POST /api/admin/roles/grant":  () => grantRoleMember(body),
      "POST /api/admin/roles/revoke": () => revokeRoleMember(body),
      // Business layer — orgChart / projects / contactMap (mirrors `agentx business`).
      "POST /api/admin/business/orgchart":     () => upsertOrgEntry(body),
      "DELETE /api/admin/business/orgchart":   () => deleteOrgEntry(body),
      "POST /api/admin/business/project":      () => upsertProject(body),
      "DELETE /api/admin/business/project":    () => deleteProject(body),
      "POST /api/admin/business/contact":      () => upsertContact(body),
      "DELETE /api/admin/business/contact":    () => deleteContact(body),
      // Boards — mirrors `agentx board` + `agentx board column` CLI.
      "POST /api/admin/boards":          () => upsertBoard(body),
      "DELETE /api/admin/boards":        () => deleteBoard(body),
      "POST /api/admin/boards/columns":  () => upsertBoardColumn(body),
      "DELETE /api/admin/boards/columns":() => deleteBoardColumn(body),
      // Notifications — single mutation endpoint that takes a partial body
      // (destination?, on?, longTaskThreshold?). Mirrors `agentx notifications`.
      "POST /api/admin/notifications":   () => updateNotifications(body),
      // Webhook triggers + defaultWorkflow editor (in addition to existing
      // /api/admin/webhooks add/edit/delete).
      "POST /api/admin/webhooks/triggers": () => updateWebhookTriggers(body),
      // Mesh health-check cadence — mirrors `agentx mesh health`.
      "POST /api/admin/mesh/health":     () => updateMeshHealth(body),
    }
    const key = `${req.method} ${path}`
    const handler = dispatch[key]
    if (!handler) { sendJson(res, 404, { error: `unknown admin endpoint: ${key}` }); return }
    const result = await handler()
    sendJson(res, 200, result)
  } catch (e: any) {
    sendJson(res, 400, { error: e.message || "admin op failed" })
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((ok, err) => {
    let raw = ""
    req.on("data", (c) => { raw += c })
    req.on("end", () => { try { ok(raw ? JSON.parse(raw) : {}) } catch (e) { err(e) } })
    req.on("error", err)
  })
}

// ========================================================================
// Read helpers — /api/admin/state returns everything the panel needs in one call
// ========================================================================

function readJsonDir(relPath: string): any[] {
  const dir = resolve(process.cwd(), relPath)
  if (!existsSync(dir)) return []
  const out: any[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    try {
      out.push(JSON.parse(readFileSync(resolve(dir, entry.name), "utf-8")))
    } catch {
      // skip malformed
    }
  }
  return out
}

function readConfigRaw(): any {
  const file = resolve(process.cwd(), "agentx.json")
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, "utf-8"))
}

function getAdminState() {
  const cfg = readConfigRaw()
  if (!cfg) return { exists: false }
  const agents = Object.entries(cfg.agents || {}).map(([id, a]: [string, any]) => ({
    id,
    name: a.name,
    tier: a.tier,
    model: a.model,
    mentions: a.mentions || [],
    workspace: a.workspace,
    access: a.access || "private",
    // Edit-form fields — cheap to include, saves a second round-trip.
    systemPrompt: a.systemPrompt || "",
    maxConcurrent: a.maxConcurrent ?? 1,
    maxExecutionMinutes: a.maxExecutionMinutes ?? 20,
    permissionMode: a.permissionMode || "default",
  }))
  const telegramAccounts = cfg.channels?.telegram?.accounts || {}
  const telegram = {
    enabled: !!cfg.channels?.telegram?.enabled,
    accounts: Object.entries(telegramAccounts).map(([id, acc]: [string, any]) => ({
      id,
      botUsername: acc.botUsername || "",
      agentBinding: acc.agentBinding || "",
      botTokenRef: acc.token || "",
    })),
  }
  const slack = {
    enabled: !!cfg.channels?.slack?.enabled,
    botTokenRef: cfg.channels?.slack?.botToken || "",
    appTokenRef: cfg.channels?.slack?.appToken || "",
    agentBinding: cfg.channels?.slack?.agentBinding || "",
  }
  const discord = {
    enabled: !!cfg.channels?.discord?.enabled,
    tokenRef: cfg.channels?.discord?.token || "",
    agentBinding: cfg.channels?.discord?.agentBinding || "",
  }
  const gitlab = {
    enabled: !!cfg.channels?.gitlab?.enabled,
    host: cfg.channels?.gitlab?.host || "",
    webhookPort: cfg.channels?.gitlab?.webhookPort || 18810,
    tokenRef: cfg.channels?.gitlab?.token || "",
    routeCount: Array.isArray(cfg.channels?.gitlab?.routes) ? cfg.channels.gitlab.routes.length : 0,
    agentMappingCount: Array.isArray(cfg.channels?.gitlab?.agentMappings) ? cfg.channels.gitlab.agentMappings.length : 0,
  }
  const whatsapp = {
    enabled: !!cfg.channels?.whatsapp?.enabled,
    sessionDir: cfg.channels?.whatsapp?.sessionDir || ".agentx/whatsapp-sessions",
    routeCount: Array.isArray(cfg.channels?.whatsapp?.routes) ? cfg.channels.whatsapp.routes.length : 0,
  }
  const crons = Object.entries(cfg.crons || {}).map(([id, c]: [string, any]) => ({
    id,
    schedule: c.schedule,
    agent: c.agent,
    prompt: (c.prompt || "").slice(0, 200),
    enabled: c.enabled !== false,
  }))
  const webhooks = Array.isArray(cfg.webhooks) ? cfg.webhooks.map((w: any) => ({
    id: w.id,
    source: w.source,
    agentId: w.agentId,
    secretEnv: w.secretEnv || "",
    description: w.description || "",
    enabled: w.enabled !== false,
    // Trigger / defaultWorkflow routing — surfaced so the Webhooks tab
    // can render them inline without a second round-trip.
    triggers: (w.triggers && typeof w.triggers === "object") ? w.triggers : {},
    defaultWorkflow: w.defaultWorkflow || "",
  })) : []
  const mesh = {
    enabled: !!cfg.mesh?.enabled,
    discovery: cfg.mesh?.discovery || "static",
    peers: (cfg.mesh?.peers || []).map((p: any) => ({
      url: p.url,
      name: p.name,
      hasToken: !!p.token,
    })),
    healthCheck: {
      interval: cfg.mesh?.healthCheck?.interval ?? 60,
      timeout: cfg.mesh?.healthCheck?.timeout ?? 10,
    },
  }
  // Daemon URL — used by the admin UI to compose full webhook URLs for copy.
  const daemonUrl = cfg.dashboard?.daemonUrl || "http://localhost:18800"
  // Actors and roles — read directly from .agentx/actors and .agentx/roles
  // so this stays in lockstep with `agentx actor`/`agentx role` CLI
  // mutations without coupling to the ActorStore class (which lives in
  // a chunk loaded only on the BPM dispatcher path).
  const actors = readJsonDir(".agentx/actors").map((a: any) => ({
    id: a.id, name: a.name, email: a.email,
    channels: Array.isArray(a.channels) ? a.channels.map((c: any) => ({
      channel: c.channel, handle: c.handle, preferredForTasks: !!c.preferredForTasks,
    })) : [],
    timezone: a.timezone,
  })).sort((a: any, b: any) => a.id.localeCompare(b.id))
  const roles = readJsonDir(".agentx/roles").map((r: any) => ({
    id: r.id, name: r.name,
    members: Array.isArray(r.members) ? r.members : [],
    assignmentStrategy: r.assignmentStrategy || "first-available",
  })).sort((a: any, b: any) => a.id.localeCompare(b.id))
  // Business layer — read straight off the config so the panel stays in
  // sync with `agentx business` CLI mutations.
  const businessCfg = (cfg.business || {}) as any
  const business = {
    enabled: !!businessCfg.enabled,
    timezone: businessCfg.timezone || "UTC",
    orgChart: businessCfg.orgChart || {},
    projects: Array.isArray(businessCfg.projects) ? businessCfg.projects : [],
    contactMap: Array.isArray(businessCfg.contactMap) ? businessCfg.contactMap : [],
  }
  // Notifications — destination + event toggles + long-task threshold.
  const notificationsCfg = (cfg.notifications || {}) as any
  const notifications = {
    longTaskThreshold: notificationsCfg.longTaskThreshold ?? 30,
    destination: notificationsCfg.destination || null,
    on: {
      taskComplete: notificationsCfg.on?.taskComplete !== false,
      taskError: notificationsCfg.on?.taskError !== false,
      taskQueued: !!notificationsCfg.on?.taskQueued,
    },
  }
  // Actions — load all registered actions for the Actions tab.
  let actions: Array<any> = []
  try {
    const items = readJsonDir(".agentx/actions")
    actions = items.filter((a: any) => a && typeof a === "object" && a.id).map((a: any) => ({
      id: a.id,
      title: a.title,
      kind: a.kind,
      description: a.description || "",
      inputs: Array.isArray(a.inputs) ? a.inputs : [],
      timeoutMs: a.timeoutMs ?? 30_000,
      // Surface the kind-specific summary fields the tab renders.
      command: a.kind === "shell" ? a.command : undefined,
      url: a.kind === "http" ? a.url : undefined,
      method: a.kind === "http" ? a.method : undefined,
    })).sort((a: any, b: any) => a.id.localeCompare(b.id))
  } catch { /* empty registry is fine */ }
  // Boards — list with column metadata so the admin tab can edit them.
  const boards = (Array.isArray(cfg.boards) ? cfg.boards : []).map((b: any) => ({
    id: b.id,
    name: b.name,
    source: b.source || { type: "gitlab", projects: [] },
    primaryToolLabel: b.primaryToolLabel || "",
    timeRangeDays: b.timeRangeDays ?? 30,
    closedWindowDays: b.closedWindowDays ?? 30,
    columns: Array.isArray(b.columns) ? b.columns : [],
  }))
  return { exists: true, agents, telegram, slack, discord, gitlab, whatsapp, crons, webhooks, mesh, daemonUrl, nodeName: cfg.node?.name, actors, roles, business, boards, notifications, actions }
}

// ========================================================================
// Mutations
// ========================================================================

function setAgentAccess(body: any) {
  const id = String(body?.id || "").trim()
  const access = body?.access === "public" ? "public" : "private"
  if (!id) throw new Error("Agent id is required.")
  const { summary } = mutateAgentxConfig((cfg) => {
    if (!cfg.agents?.[id]) throw new Error(`Agent "${id}" not found.`)
    cfg.agents[id].access = access
    return `agent "${id}" is now ${access}`
  })
  return { summary }
}

function listTokens() {
  return new TokenStore().list().map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    lastUsedAt: r.lastUsedAt,
  }))
}

function createToken(body: any) {
  const name = String(body?.name || "").trim()
  const scopes = Array.isArray(body?.scopes) ? body.scopes.map(String) : []
  const expiresInDays = body?.expiresInDays ? Number(body.expiresInDays) : undefined
  const { token, record } = new TokenStore().create({ name, scopes, expiresInDays })
  // Return the secret in the body exactly once — the UI must surface it
  // immediately and then forget it (no re-display after refresh).
  return { summary: `created token "${name}"`, token, record }
}

function revokeToken(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("Token id is required.")
  const rec = new TokenStore().revoke(id)
  if (!rec) throw new Error(`Token "${id}" not found.`)
  return { summary: `revoked token ${id} (${rec.name})` }
}

/**
 * Admin-only shortcut that sends a message to an agent and returns the full
 * reply. Used by the dashboard's "Test drive" chat modal so operators can
 * sanity-check a freshly configured agent before wiring a real channel.
 *
 * Routes through the daemon's /task endpoint (unchanged runtime semantics)
 * and labels the run with channel="test-drive" so it's obvious in the task
 * history / dashboard. A stable chatId lets the agent's session carry
 * context across follow-up messages within one modal sitting.
 */
async function testDriveAgent(body: any) {
  const id = String(body?.agent || body?.id || "").trim()
  const message = String(body?.message || "").trim()
  const chatId = String(body?.chatId || "").trim() || `admin-${Date.now()}`
  if (!id) throw new Error("Agent id is required.")
  if (!message) throw new Error("Message is required.")

  // Resolve the primary daemon URL from config. Fall back to the local default.
  let daemonUrl = "http://127.0.0.1:18800"
  let daemonToken: string | undefined
  try {
    const cfg = loadDaemonConfig()
    daemonUrl = cfg.dashboard.daemonUrl.replace(/\/+$/, "") || daemonUrl
    daemonToken = cfg.dashboard.token
  } catch { /* missing config shouldn't block test-drive */ }

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (daemonToken) headers["Authorization"] = `Bearer ${daemonToken}`

  const r = await fetch(`${daemonUrl}/task`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: id,
      message,
      context: { channel: "test-drive", sender: "admin", chatId },
    }),
  })
  const text = await r.text()
  let parsed: any
  try { parsed = JSON.parse(text) } catch { parsed = { content: text } }
  if (!r.ok) {
    throw new Error(parsed?.error || `daemon HTTP ${r.status}`)
  }
  return { chatId, response: parsed }
}

function addAgent(body: any) {
  const id = String(body?.id || "").trim()
  const name = String(body?.name || "").trim()
  const tier = body?.tier === "sdk" ? "sdk" : "claude-code"
  const mentions = normaliseMentions(body?.triggerWords)
  const model = body?.model ? String(body.model).trim() : undefined
  const personality = body?.personality ? String(body.personality).trim() : undefined
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("Agent id must be lowercase (letters, digits, -, _).")
  if (!name) throw new Error("Agent name is required.")
  if (mentions.length === 0) throw new Error("At least one trigger word is required.")

  const workspace = resolve(process.cwd(), "agents", id)
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.agents = cfg.agents || {}
    if (cfg.agents[id]) throw new Error(`Agent "${id}" already exists.`)
    const block: any = {
      name, workspace, tier, mentions, maxConcurrent: 2, permissionMode: "default",
    }
    if (model) block.model = model
    if (personality) block.systemPrompt = personality.slice(0, 400)
    cfg.agents[id] = block
    return `added agent "${id}"`
  })
  // Scaffold the workspace if it doesn't exist.
  const claudeMd = resolve(workspace, "CLAUDE.md")
  if (!existsSync(claudeMd)) {
    try {
      mkdirSync(workspace, { recursive: true })
      writeFileSync(claudeMd, `# ${name}\n\n${personality || "You are " + name + "."}\n`)
    } catch { /* best-effort */ }
  }
  return { summary }
}

function editAgent(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("Agent id is required.")
  const patch = body?.patch || {}
  const { summary } = mutateAgentxConfig((cfg) => {
    if (!cfg.agents?.[id]) throw new Error(`Agent "${id}" not found.`)
    const a = cfg.agents[id]
    // Whitelist every field the admin UI is allowed to change. Anything outside
    // this list requires the raw JSON editor — keeps the simple form from
    // silently nuking nested config shapes.
    if (typeof patch.name === "string" && patch.name.trim()) a.name = patch.name.trim()
    if (typeof patch.model === "string") a.model = patch.model.trim() || undefined
    if (typeof patch.tier === "string" && ["claude-code", "sdk", "orchestrator"].includes(patch.tier)) a.tier = patch.tier
    if (typeof patch.systemPrompt === "string") a.systemPrompt = patch.systemPrompt.trim() || undefined
    if (Array.isArray(patch.mentions)) {
      a.mentions = patch.mentions.map((m: any) => String(m).trim()).filter(Boolean)
    } else if (typeof patch.triggerWords === "string") {
      a.mentions = normaliseMentions(patch.triggerWords)
    }
    if (typeof patch.maxConcurrent === "number" && patch.maxConcurrent >= 1) a.maxConcurrent = patch.maxConcurrent
    if (typeof patch.maxExecutionMinutes === "number" && patch.maxExecutionMinutes >= 1 && patch.maxExecutionMinutes <= 240) {
      a.maxExecutionMinutes = patch.maxExecutionMinutes
    }
    if (typeof patch.permissionMode === "string") a.permissionMode = patch.permissionMode
    if (patch.access === "public" || patch.access === "private") a.access = patch.access
    return `updated agent "${id}"`
  })
  return { summary }
}

function deleteAgent(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("Agent id is required.")
  const { summary } = mutateAgentxConfig((cfg) => {
    if (!cfg.agents || !cfg.agents[id]) throw new Error(`Agent "${id}" not found.`)
    delete cfg.agents[id]
    // Also clear any channel bindings pointing at this agent.
    if (cfg.channels?.telegram?.accounts) {
      for (const k of Object.keys(cfg.channels.telegram.accounts)) {
        if (cfg.channels.telegram.accounts[k]?.agentBinding === id) {
          cfg.channels.telegram.accounts[k].agentBinding = ""
        }
      }
    }
    return `removed agent "${id}"`
  })
  return { summary }
}

function addTelegramAccount(body: any) {
  const id = String(body?.id || "").trim()
  const agentBinding = String(body?.agentBinding || "").trim()
  const botUsername = String(body?.botUsername || "").trim()
  const botTokenEnv = String(body?.botTokenEnv || "").trim()
  if (!id) throw new Error("Account id is required.")
  if (!agentBinding) throw new Error("Choose an agent to bind this account to.")
  if (!botTokenEnv) throw new Error("Bot token env-var name is required (e.g. TG_SUPPORT_BOT_TOKEN).")
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.channels = cfg.channels || {}
    cfg.channels.telegram = cfg.channels.telegram || { enabled: true, accounts: {}, policy: { dm: "pair", group: "mention-required" } }
    cfg.channels.telegram.enabled = true
    cfg.channels.telegram.accounts = cfg.channels.telegram.accounts || {}
    if (cfg.channels.telegram.accounts[id]) throw new Error(`Telegram account "${id}" already exists.`)
    if (!cfg.agents?.[agentBinding]) throw new Error(`Unknown agent "${agentBinding}".`)
    // Schema (telegramAccountSchema) keys are `token` + `agentBinding`. Zod
    // silently strips unknown fields, so writing `botToken` produced configs
    // that failed to validate with `token: Required` even after the operator
    // added the env var. `botUsername` is not in the schema; passing it does
    // nothing (kept here only because the form collects it — drop once the
    // form is updated to omit it).
    void botUsername
    cfg.channels.telegram.accounts[id] = {
      token: "${" + botTokenEnv + "}",
      agentBinding,
    }
    return `added telegram account "${id}"`
  })
  return { summary, hint: `Add ${botTokenEnv}=<bot-token> to your .env file.` }
}

function editTelegramAccount(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("Account id is required.")
  const patch = body?.patch || {}
  const { summary } = mutateAgentxConfig((cfg) => {
    const acc = cfg.channels?.telegram?.accounts?.[id]
    if (!acc) throw new Error(`Account "${id}" not found.`)
    if (typeof patch.agentBinding === "string" && patch.agentBinding.trim()) {
      if (!cfg.agents?.[patch.agentBinding]) throw new Error(`Unknown agent "${patch.agentBinding}".`)
      acc.agentBinding = patch.agentBinding.trim()
    }
    if (typeof patch.botUsername === "string") acc.botUsername = patch.botUsername.trim()
    if (typeof patch.botTokenEnv === "string" && patch.botTokenEnv.trim()) {
      acc.token = "${" + patch.botTokenEnv.trim() + "}"
    }
    return `updated telegram account "${id}"`
  })
  return { summary }
}

/**
 * Forward a GET to the daemon and return its JSON body. Used for state
 * that lives in the daemon process (WhatsApp QR/connection, etc.) since the
 * board server is a separate process with separate memory.
 */
async function proxyDaemonJson(pathOnDaemon: string): Promise<any> {
  const { url, headers } = daemonTarget()
  const r = await fetch(url + pathOnDaemon, { headers })
  const text = await r.text()
  if (!r.ok) throw new Error(`daemon ${r.status}: ${text.slice(0, 200)}`)
  try { return JSON.parse(text) } catch { return { raw: text } }
}

/** POST variant — forwards a JSON body to a daemon endpoint and returns
 *  the parsed JSON. Used to reach daemon-process-owned operations like
 *  WhatsApp ingest from the dashboard process. */
async function proxyDaemonPostJson(pathOnDaemon: string, body: any): Promise<any> {
  const { url, headers } = daemonTarget()
  const r = await fetch(url + pathOnDaemon, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`daemon ${r.status}: ${text.slice(0, 200)}`)
  try { return JSON.parse(text) } catch { return { raw: text } }
}

/**
 * Proxy a non-JSON response (SVG, binary) from the daemon straight through.
 */
async function proxyDaemonSvg(res: ServerResponse, pathOnDaemon: string): Promise<void> {
  try {
    const { url, headers } = daemonTarget()
    const r = await fetch(url + pathOnDaemon, { headers })
    const body = await r.text()
    res.writeHead(r.status, {
      "Content-Type": r.headers.get("content-type") || "image/svg+xml",
      "Cache-Control": "no-store",
    })
    res.end(body)
  } catch (e: any) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("daemon unreachable: " + (e?.message || "unknown"))
  }
}

function daemonTarget(): { url: string; headers: Record<string, string> } {
  let url = "http://127.0.0.1:18800"
  const headers: Record<string, string> = {}
  try {
    const cfg = loadDaemonConfig()
    url = cfg.dashboard.daemonUrl?.replace(/\/+$/, "") || url
    if (cfg.dashboard.token) headers["Authorization"] = `Bearer ${cfg.dashboard.token}`
  } catch { /* */ }
  return { url, headers }
}

// --- per-agent file operations ---------------------------------------------

function workspaceFor(agentId: string): string {
  const cfg = readConfigRaw()
  const def = cfg?.agents?.[agentId]
  if (!def) throw new Error(`Unknown agent "${agentId}".`)
  if (!def.workspace) throw new Error(`Agent "${agentId}" has no workspace configured.`)
  return def.workspace
}

function queryParam(req: IncomingMessage, name: string): string {
  try {
    const url = new URL(req.url || "/", "http://localhost")
    return url.searchParams.get(name) || ""
  } catch { return "" }
}

function listFilesForAgent(req: IncomingMessage) {
  const agentId = queryParam(req, "agent").trim()
  if (!agentId) throw new Error("agent= query param is required.")
  const overview = listAgentFiles(workspaceFor(agentId))
  return { agentId, ...overview }
}

function readFileForAgent(req: IncomingMessage) {
  const agentId = queryParam(req, "agent").trim()
  const path = queryParam(req, "path").trim()
  if (!agentId || !path) throw new Error("agent= and path= query params are required.")
  return readAgentFile(workspaceFor(agentId), path)
}

function writeFileForAgent(body: any) {
  const agentId = String(body?.agent || "").trim()
  const path = String(body?.path || "").trim()
  const content = typeof body?.content === "string" ? body.content : ""
  if (!agentId || !path) throw new Error("agent and path are required.")
  const r = writeAgentFile(workspaceFor(agentId), path, content)
  return { summary: `saved ${path} (${r.bytes} bytes)`, ...r }
}

function addSkillForAgent(body: any) {
  const agentId = String(body?.agent || "").trim()
  const slug = String(body?.slug || "").trim()
  const title = body?.title ? String(body.title) : undefined
  const content = body?.content ? String(body.content) : undefined
  if (!agentId) throw new Error("agent is required.")
  const r = createAgentSkill(workspaceFor(agentId), slug, { title, content })
  return { summary: `added skill "${slug}"`, ...r }
}

function removeSkillForAgent(body: any) {
  const agentId = String(body?.agent || "").trim()
  const slug = String(body?.slug || "").trim()
  if (!agentId || !slug) throw new Error("agent and slug are required.")
  const r = deleteAgentSkill(workspaceFor(agentId), slug)
  return { summary: `removed skill "${slug}"`, ...r }
}

const WEBHOOK_SOURCES = ["gitlab", "github", "sentry", "stripe", "discord", "slack", "custom"] as const

function addWebhook(body: any) {
  const id = String(body?.id || "").trim()
  const source = String(body?.source || "").trim()
  const agentId = String(body?.agentId || "").trim()
  const secretEnv = String(body?.secretEnv || "").trim()
  const description = String(body?.description || "").trim()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("Webhook id must be lowercase (letters, digits, -, _).")
  if (!WEBHOOK_SOURCES.includes(source as any)) throw new Error(`Unknown source: ${source}`)
  if (!agentId) throw new Error("Pick an agent to bind the webhook to.")
  const { summary } = mutateAgentxConfig((cfg) => {
    if (!cfg.agents?.[agentId]) throw new Error(`Unknown agent "${agentId}".`)
    cfg.webhooks = Array.isArray(cfg.webhooks) ? cfg.webhooks : []
    if (cfg.webhooks.find((w: any) => w.id === id)) throw new Error(`Webhook "${id}" already exists.`)
    const entry: any = { id, source, agentId, enabled: true }
    if (secretEnv) entry.secretEnv = secretEnv
    if (description) entry.description = description
    cfg.webhooks.push(entry)
    return `added webhook "${id}" (${source} → ${agentId})`
  })
  return { summary }
}

function editWebhook(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("Webhook id is required.")
  const patch = body?.patch || {}
  const { summary } = mutateAgentxConfig((cfg) => {
    const w = (cfg.webhooks || []).find((x: any) => x.id === id)
    if (!w) throw new Error(`Webhook "${id}" not found.`)
    if (typeof patch.source === "string" && WEBHOOK_SOURCES.includes(patch.source as any)) w.source = patch.source
    if (typeof patch.agentId === "string" && patch.agentId.trim()) {
      if (!cfg.agents?.[patch.agentId]) throw new Error(`Unknown agent "${patch.agentId}".`)
      w.agentId = patch.agentId.trim()
    }
    if (typeof patch.secretEnv === "string") w.secretEnv = patch.secretEnv.trim() || undefined
    if (typeof patch.description === "string") w.description = patch.description.trim() || undefined
    if (typeof patch.enabled === "boolean") w.enabled = patch.enabled
    return `updated webhook "${id}"`
  })
  return { summary }
}

function addMeshPeer(body: any) {
  const url = String(body?.url || "").trim().replace(/\/+$/, "")
  const name = String(body?.name || "").trim()
  const token = String(body?.token || "").trim() || undefined
  if (!url || !/^https?:\/\//.test(url)) throw new Error("Peer URL must start with http:// or https://")
  if (!name) throw new Error("Peer name is required.")
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.mesh = cfg.mesh || { enabled: true, peers: [], discovery: "static", healthCheck: { interval: 60, timeout: 10 } }
    cfg.mesh.enabled = true
    cfg.mesh.peers = Array.isArray(cfg.mesh.peers) ? cfg.mesh.peers : []
    if (cfg.mesh.peers.find((p: any) => p.url === url)) throw new Error(`Peer at ${url} already registered.`)
    const entry: any = { url, name }
    if (token) entry.token = token
    cfg.mesh.peers.push(entry)
    return `added mesh peer "${name}"`
  })
  return { summary }
}

function deleteMeshPeer(body: any) {
  const url = String(body?.url || "").trim().replace(/\/+$/, "")
  if (!url) throw new Error("Peer URL is required.")
  const { summary } = mutateAgentxConfig((cfg) => {
    const before = (cfg.mesh?.peers || []).length
    cfg.mesh = cfg.mesh || { enabled: false, peers: [], discovery: "static", healthCheck: { interval: 60, timeout: 10 } }
    cfg.mesh.peers = (cfg.mesh.peers || []).filter((p: any) => p.url.replace(/\/+$/, "") !== url)
    if (cfg.mesh.peers.length === before) throw new Error(`Peer at ${url} not found.`)
    return `removed mesh peer ${url}`
  })
  return { summary }
}

function toggleMesh(body: any) {
  const enabled = !!body?.enabled
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.mesh = cfg.mesh || { enabled, peers: [], discovery: "static", healthCheck: { interval: 60, timeout: 10 } }
    cfg.mesh.enabled = enabled
    return `mesh ${enabled ? "enabled" : "disabled"}`
  })
  return { summary }
}

function deleteWebhook(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("Webhook id is required.")
  const { summary } = mutateAgentxConfig((cfg) => {
    const before = (cfg.webhooks || []).length
    cfg.webhooks = (cfg.webhooks || []).filter((w: any) => w.id !== id)
    if (cfg.webhooks.length === before) throw new Error(`Webhook "${id}" not found.`)
    return `removed webhook "${id}"`
  })
  return { summary }
}

function configureSlack(body: any) {
  const botTokenEnv = String(body?.botTokenEnv || "").trim()
  const appTokenEnv = String(body?.appTokenEnv || "").trim()
  const agentBinding = String(body?.agentBinding || "").trim()
  if (!botTokenEnv) throw new Error("Bot token env-var name is required (e.g. SLACK_BOT_TOKEN).")
  if (!appTokenEnv) throw new Error("App-level token env-var name is required (e.g. SLACK_APP_TOKEN).")
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.channels = cfg.channels || {}
    cfg.channels.slack = cfg.channels.slack || { enabled: false }
    cfg.channels.slack.enabled = true
    cfg.channels.slack.botToken = "${" + botTokenEnv + "}"
    cfg.channels.slack.appToken = "${" + appTokenEnv + "}"
    if (agentBinding) {
      if (!cfg.agents?.[agentBinding]) throw new Error(`Unknown agent "${agentBinding}".`)
      cfg.channels.slack.agentBinding = agentBinding
    }
    return "configured slack connector"
  })
  return { summary, hint: `Add ${botTokenEnv}=xoxb-… and ${appTokenEnv}=xapp-… to your .env.` }
}

function toggleSlack(body: any) {
  const enabled = !!body?.enabled
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.channels = cfg.channels || {}
    cfg.channels.slack = cfg.channels.slack || { enabled: false }
    cfg.channels.slack.enabled = enabled
    return `slack ${enabled ? "enabled" : "disabled"}`
  })
  return { summary }
}

function configureDiscord(body: any) {
  const tokenEnv = String(body?.tokenEnv || "").trim()
  const agentBinding = String(body?.agentBinding || "").trim()
  if (!tokenEnv) throw new Error("Bot token env-var name is required (e.g. DISCORD_BOT_TOKEN).")
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.channels = cfg.channels || {}
    cfg.channels.discord = cfg.channels.discord || { enabled: false }
    cfg.channels.discord.enabled = true
    cfg.channels.discord.token = "${" + tokenEnv + "}"
    if (agentBinding) {
      if (!cfg.agents?.[agentBinding]) throw new Error(`Unknown agent "${agentBinding}".`)
      cfg.channels.discord.agentBinding = agentBinding
    }
    return "configured discord connector"
  })
  return { summary, hint: `Add ${tokenEnv}=<bot-token> to your .env.` }
}

function toggleDiscord(body: any) {
  const enabled = !!body?.enabled
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.channels = cfg.channels || {}
    cfg.channels.discord = cfg.channels.discord || { enabled: false }
    cfg.channels.discord.enabled = enabled
    return `discord ${enabled ? "enabled" : "disabled"}`
  })
  return { summary }
}

function configureGitLab(body: any) {
  const host = String(body?.host || "").trim().replace(/\/+$/, "")
  const tokenEnv = String(body?.tokenEnv || "").trim()
  const webhookPort = parseInt(String(body?.webhookPort || "18810"), 10)
  if (!host || !/^https?:\/\//.test(host)) throw new Error("Host must start with http:// or https://")
  if (!tokenEnv) throw new Error("Admin token env-var name is required (e.g. GITLAB_TOKEN).")
  if (!Number.isFinite(webhookPort) || webhookPort < 1 || webhookPort > 65535) throw new Error("Webhook port must be between 1 and 65535.")
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.channels = cfg.channels || {}
    cfg.channels.gitlab = cfg.channels.gitlab || { enabled: false, routes: [], agentMappings: [] }
    cfg.channels.gitlab.enabled = true
    cfg.channels.gitlab.host = host
    cfg.channels.gitlab.token = "${" + tokenEnv + "}"
    cfg.channels.gitlab.webhookPort = webhookPort
    return "configured gitlab connector"
  })
  return { summary, hint: `Add ${tokenEnv}=<personal-access-token> to your .env. Per-project routes + per-agent tokens stay in the Advanced JSON editor.` }
}

function toggleGitLab(body: any) {
  const enabled = !!body?.enabled
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.channels = cfg.channels || {}
    cfg.channels.gitlab = cfg.channels.gitlab || { enabled: false, routes: [], agentMappings: [] }
    cfg.channels.gitlab.enabled = enabled
    return `gitlab ${enabled ? "enabled" : "disabled"}`
  })
  return { summary }
}

async function previewCron(body: any) {
  const expr = String(body?.schedule || "").trim()
  if (!expr) throw new Error("schedule is required")
  const { getNextCronDate } = await import("@/crons/scheduler")
  let human: string | undefined
  try {
    const cronstrue = (await import("cronstrue")).default
    human = cronstrue.toString(expr, { use24HourTimeFormat: false })
  } catch (e: any) {
    throw new Error(`Invalid cron: ${e.message || "unknown"}`)
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const next: string[] = []
  let cursor = new Date()
  try {
    for (let i = 0; i < 3; i++) {
      cursor = getNextCronDate(expr, cursor, tz)
      next.push(cursor.toISOString())
    }
  } catch (e: any) {
    throw new Error(`Cron preview failed: ${e.message}`)
  }
  return { human, next, timezone: tz }
}

function deleteTelegramAccount(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("Account id is required.")
  const { summary } = mutateAgentxConfig((cfg) => {
    if (!cfg.channels?.telegram?.accounts?.[id]) throw new Error(`Account "${id}" not found.`)
    delete cfg.channels.telegram.accounts[id]
    return `removed telegram account "${id}"`
  })
  return { summary }
}

function toggleTelegram(body: any) {
  const enabled = !!body?.enabled
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.channels = cfg.channels || {}
    cfg.channels.telegram = cfg.channels.telegram || { enabled: false, accounts: {}, policy: { dm: "pair", group: "mention-required" } }
    cfg.channels.telegram.enabled = enabled
    return `telegram ${enabled ? "enabled" : "disabled"}`
  })
  return { summary }
}

function addCron(body: any) {
  const id = String(body?.id || "").trim()
  const schedule = String(body?.schedule || "").trim()
  const agent = String(body?.agent || "").trim()
  const prompt = String(body?.prompt || "").trim()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("Cron id must be lowercase (letters, digits, -, _).")
  if (!schedule) throw new Error("Cron expression is required (e.g. '0 9 * * 1' for Mondays at 9am).")
  if (!agent) throw new Error("Pick an agent to run this schedule.")
  if (!prompt) throw new Error("A prompt is required (what should the agent do?).")
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.crons = cfg.crons || {}
    if (cfg.crons[id]) throw new Error(`Cron "${id}" already exists.`)
    if (!cfg.agents?.[agent]) throw new Error(`Unknown agent "${agent}".`)
    cfg.crons[id] = { schedule, agent, prompt, enabled: true }
    return `added cron "${id}"`
  })
  return { summary }
}

function deleteCron(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("Cron id is required.")
  const { summary } = mutateAgentxConfig((cfg) => {
    if (!cfg.crons?.[id]) throw new Error(`Cron "${id}" not found.`)
    delete cfg.crons[id]
    return `removed cron "${id}"`
  })
  return { summary }
}

function replaceConfigRaw(body: any): { summary: string; backupPath?: string } {
  const raw = String(body?.raw || "")
  if (!raw.trim()) throw new Error("Config body is empty.")
  let parsed: any
  try { parsed = JSON.parse(raw) }
  catch (e: any) { throw new Error(`Invalid JSON: ${e.message}`) }
  const file = resolve(process.cwd(), "agentx.json")
  const backupPath = `${file}.bak.${Date.now()}`
  if (existsSync(file)) {
    try { copyFileSync(file, backupPath) } catch { /* best-effort */ }
  }
  writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n", "utf-8")
  // Best-effort /reload; caller can also restart the daemon.
  try {
    const cfg = loadDaemonConfig()
    const url = cfg.dashboard.daemonUrl?.replace(/\/+$/, "") || "http://127.0.0.1:18800"
    fetch(`${url}/reload`, { method: "POST" }).catch(() => null)
  } catch { /* daemon may not be running */ }
  return { summary: "agentx.json replaced", backupPath }
}

function normaliseMentions(s: any): string[] {
  return String(s || "")
    .split(/[,\s]+/)
    .map((m) => m.trim())
    .filter(Boolean)
    .filter((m, i, a) => a.indexOf(m) === i)
}

// ========================================================================
// Actors & Roles — admin write handlers (mirrors `agentx actor` / `agentx role`)
// ========================================================================

async function loadActorStore(): Promise<typeof import("@/actors/store").ActorStore.prototype> {
  const { ActorStore } = await import("@/actors/store")
  return new ActorStore()
}

async function upsertActor(body: any) {
  const id = String(body?.id || "").trim()
  const name = String(body?.name || "").trim()
  if (!id.startsWith("actor:")) throw new Error("id must start with 'actor:'")
  if (!name) throw new Error("name required")
  const channels = Array.isArray(body?.channels) ? body.channels : []
  if (channels.length === 0) throw new Error("at least one channel handle required")
  const store = await loadActorStore()
  const saved = store.saveActor({
    id, name,
    email: body?.email || undefined,
    channels: channels.map((c: any) => ({
      channel: c.channel,
      handle: String(c.handle || "").trim(),
      preferredForTasks: !!c.preferredForTasks,
    })).filter((c: any) => c.handle),
    timezone: body?.timezone || undefined,
  })
  return { summary: `Actor ${saved.id} saved`, actor: saved }
}

async function deleteActorById(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("id required")
  const store = await loadActorStore()
  if (!store.deleteActor(id)) throw new Error(`actor ${id} not found`)
  return { summary: `Actor ${id} deleted` }
}

async function upsertRole(body: any) {
  const id = String(body?.id || "").trim()
  const name = String(body?.name || "").trim()
  if (!id.startsWith("role:")) throw new Error("id must start with 'role:'")
  if (!name) throw new Error("name required")
  const strategy = body?.assignmentStrategy || "first-available"
  const store = await loadActorStore()
  const existing = store.getRole(id)
  const saved = store.saveRole({
    id, name,
    members: Array.isArray(body?.members) ? body.members : (existing?.members || []),
    assignmentStrategy: strategy,
    rotationCursor: existing?.rotationCursor ?? 0,
  })
  return { summary: `Role ${saved.id} saved`, role: saved }
}

async function deleteRoleById(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("id required")
  const store = await loadActorStore()
  if (!store.deleteRole(id)) throw new Error(`role ${id} not found`)
  return { summary: `Role ${id} deleted` }
}

async function grantRoleMember(body: any) {
  const roleId = String(body?.role || "").trim()
  const member = String(body?.member || "").trim()  // "actor:xyz" or "role:abc"
  if (!roleId.startsWith("role:")) throw new Error("role required")
  if (!member.startsWith("actor:") && !member.startsWith("role:")) throw new Error("member must be actor:<id> or role:<id>")
  const store = await loadActorStore()
  const role = store.getRole(roleId)
  if (!role) throw new Error(`role ${roleId} not found`)
  const next = member.startsWith("actor:")
    ? { actor: member }
    : { role: member }
  const dup = role.members.some((m) => ("actor" in m ? m.actor : m.role) === member)
  if (dup) return { summary: `${member} already in ${roleId}`, role }
  const saved = store.saveRole({ ...role, members: [...role.members, next] })
  return { summary: `${member} granted to ${roleId}`, role: saved }
}

async function revokeRoleMember(body: any) {
  const roleId = String(body?.role || "").trim()
  const member = String(body?.member || "").trim()
  if (!roleId.startsWith("role:")) throw new Error("role required")
  const store = await loadActorStore()
  const role = store.getRole(roleId)
  if (!role) throw new Error(`role ${roleId} not found`)
  const filtered = role.members.filter((m) => ("actor" in m ? m.actor : m.role) !== member)
  if (filtered.length === role.members.length) return { summary: `${member} not in ${roleId}`, role }
  const saved = store.saveRole({ ...role, members: filtered })
  return { summary: `${member} revoked from ${roleId}`, role: saved }
}

// ========================================================================
// Business layer — admin write handlers (mirrors `agentx business`)
// ========================================================================

async function upsertOrgEntry(body: any) {
  const agentId = String(body?.agentId || "").trim()
  const role = String(body?.role || "").trim()
  if (!agentId) throw new Error("agentId required")
  if (!role) throw new Error("role required")
  const days = Array.isArray(body?.days) && body.days.length > 0
    ? body.days
    : ["mon", "tue", "wed", "thu", "fri"]
  const start = String(body?.start || "09:00")
  const end = String(body?.end || "17:00")
  const reportsTo = body?.reportsTo ? String(body.reportsTo).trim() : ""
  const utilization = typeof body?.utilizationTarget === "number" ? body.utilizationTarget : 0.8
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.business = cfg.business || {}
    cfg.business.orgChart = cfg.business.orgChart || {}
    cfg.business.orgChart[agentId] = {
      role,
      ...(reportsTo ? { reportsTo } : {}),
      schedule: { days, start, end },
      utilizationTarget: utilization,
    }
    return `orgChart "${agentId}" upserted`
  })
  return { summary }
}

async function deleteOrgEntry(body: any) {
  const agentId = String(body?.agentId || "").trim()
  if (!agentId) throw new Error("agentId required")
  const { summary } = mutateAgentxConfig((cfg) => {
    if (!cfg.business?.orgChart || !(agentId in cfg.business.orgChart)) {
      throw new Error(`no orgChart entry for "${agentId}"`)
    }
    delete cfg.business.orgChart[agentId]
    return `orgChart "${agentId}" removed`
  })
  return { summary }
}

async function upsertProject(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("project id required")
  const pm = body?.pm ? String(body.pm).trim() : ""
  const client = body?.client ? String(body.client).trim() : ""
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.business = cfg.business || {}
    cfg.business.projects = cfg.business.projects || []
    const idx = cfg.business.projects.findIndex((p: any) => p.id === id)
    const next: any = { id, ...(pm ? { pm } : {}), ...(client ? { client } : {}) }
    if (idx >= 0) cfg.business.projects[idx] = { ...cfg.business.projects[idx], ...next }
    else cfg.business.projects.push(next)
    return idx >= 0 ? `project "${id}" updated` : `project "${id}" added`
  })
  return { summary }
}

async function deleteProject(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("project id required")
  const { summary } = mutateAgentxConfig((cfg) => {
    const list = cfg.business?.projects || []
    const before = list.length
    cfg.business.projects = list.filter((p: any) => p.id !== id)
    if (cfg.business.projects.length === before) throw new Error(`no project "${id}"`)
    return `project "${id}" removed`
  })
  return { summary }
}

async function upsertContact(body: any) {
  const client = String(body?.client || "").trim()
  if (!client) throw new Error("client required")
  if (!body?.chatId && !body?.username && !body?.senderId) {
    throw new Error("one of chatId / username / senderId required")
  }
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.business = cfg.business || {}
    cfg.business.contactMap = cfg.business.contactMap || []
    const entry: any = { client }
    if (body?.channel) entry.channel = String(body.channel)
    if (body?.chatId) entry.chatId = String(body.chatId)
    if (body?.username) entry.username = String(body.username)
    if (body?.senderId) entry.senderId = String(body.senderId)
    if (body?.project) entry.project = String(body.project)
    if (body?.displayName) entry.displayName = String(body.displayName)
    cfg.business.contactMap.push(entry)
    const key = entry.chatId || entry.username || entry.senderId
    return `contact ${entry.channel ? entry.channel + "/" : ""}${key} → ${client} added`
  })
  return { summary }
}

async function deleteContact(body: any) {
  const filters = ["channel", "chatId", "username", "senderId"]
  const provided = filters.filter((f) => body?.[f])
  if (provided.length === 0) throw new Error("at least one filter (channel/chatId/username/senderId) required")
  const { summary } = mutateAgentxConfig((cfg) => {
    const list = cfg.business?.contactMap || []
    const before = list.length
    cfg.business.contactMap = list.filter((c: any) => {
      // Drop entries that match every provided filter; keep the rest.
      for (const f of provided) {
        if (c[f] !== body[f]) return true
      }
      return false
    })
    if (cfg.business.contactMap.length === before) throw new Error("no matching contact entry")
    return `${before - cfg.business.contactMap.length} contact entry/entries removed`
  })
  return { summary }
}

// ========================================================================
// Boards — admin write handlers (mirrors `agentx board` + `agentx board column`)
// ========================================================================

async function upsertBoard(body: any) {
  const id = String(body?.id || "").trim()
  const name = String(body?.name || "").trim()
  const projectsRaw = String(body?.projects || "").split(/[,\n]/).map((s: string) => s.trim()).filter(Boolean)
  if (!id) throw new Error("id required")
  if (!name) throw new Error("name required")
  if (projectsRaw.length === 0) throw new Error("at least one project path required")
  const primaryToolLabel = body?.primaryToolLabel ? String(body.primaryToolLabel).trim() : ""
  const timeRangeDays = Number.isFinite(Number(body?.timeRangeDays)) ? Number(body.timeRangeDays) : 30
  const closedWindowDays = Number.isFinite(Number(body?.closedWindowDays)) ? Number(body.closedWindowDays) : 30
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.boards = Array.isArray(cfg.boards) ? cfg.boards : []
    const idx = cfg.boards.findIndex((b: any) => b.id === id)
    const next: any = {
      id, name,
      source: { type: "gitlab", projects: projectsRaw },
      timeRangeDays, closedWindowDays,
    }
    if (primaryToolLabel) next.primaryToolLabel = primaryToolLabel
    if (idx >= 0) {
      // Preserve any existing columns / labels — we're only editing top-level fields here.
      const prev = cfg.boards[idx]
      cfg.boards[idx] = { ...prev, ...next, columns: prev.columns, labels: prev.labels }
      return `board "${id}" updated`
    }
    cfg.boards.push(next)
    return `board "${id}" added`
  })
  return { summary }
}

async function deleteBoard(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("id required")
  const { summary } = mutateAgentxConfig((cfg) => {
    const list = Array.isArray(cfg.boards) ? cfg.boards : []
    const before = list.length
    cfg.boards = list.filter((b: any) => b.id !== id)
    if (cfg.boards.length === before) throw new Error(`board "${id}" not found`)
    return `board "${id}" removed`
  })
  return { summary }
}

async function upsertBoardColumn(body: any) {
  const boardId = String(body?.boardId || "").trim()
  const columnId = String(body?.columnId || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-")
  const title = String(body?.title || "").trim()
  const kind = String(body?.kind || "scoped-label")
  if (!boardId) throw new Error("boardId required")
  if (!columnId) throw new Error("columnId required")
  if (!title) throw new Error("title required")
  if (!["open-backlog", "scoped-label", "closed", "label"].includes(kind)) {
    throw new Error("kind must be open-backlog | scoped-label | closed | label")
  }
  const { summary } = mutateAgentxConfig((cfg) => {
    const list = Array.isArray(cfg.boards) ? cfg.boards : []
    const b = list.find((x: any) => x.id === boardId)
    if (!b) throw new Error(`board "${boardId}" not found`)
    b.columns = Array.isArray(b.columns) ? b.columns : []
    const col: any = { id: columnId, title, kind, scopedPrefix: body?.scopedPrefix || "Status" }
    if (kind === "scoped-label") {
      if (!body?.scopedLabel) throw new Error("scopedLabel required for kind=scoped-label")
      col.scopedLabel = String(body.scopedLabel)
    }
    if (kind === "label") {
      if (!body?.mapsToLabel) throw new Error("mapsToLabel required for kind=label")
      col.mapsToLabel = String(body.mapsToLabel)
    }
    if (body?.accent) col.accent = String(body.accent)
    const idx = b.columns.findIndex((c: any) => c.id === columnId)
    if (idx >= 0) { b.columns[idx] = { ...b.columns[idx], ...col }; return `column "${columnId}" updated` }
    b.columns.push(col)
    return `column "${columnId}" added to board "${boardId}"`
  })
  return { summary }
}

async function deleteBoardColumn(body: any) {
  const boardId = String(body?.boardId || "").trim()
  const columnId = String(body?.columnId || "").trim()
  if (!boardId || !columnId) throw new Error("boardId and columnId required")
  const { summary } = mutateAgentxConfig((cfg) => {
    const list = Array.isArray(cfg.boards) ? cfg.boards : []
    const b = list.find((x: any) => x.id === boardId)
    if (!b) throw new Error(`board "${boardId}" not found`)
    const before = (b.columns || []).length
    b.columns = (b.columns || []).filter((c: any) => c.id !== columnId)
    if (b.columns.length === before) throw new Error(`column "${columnId}" not found`)
    return `column "${columnId}" removed from board "${boardId}"`
  })
  return { summary }
}

// ========================================================================
// Action registry — admin write + run handlers
// ========================================================================
//
// Mirrors the `agentx actions` CLI: upsert / delete / run actions stored
// under `.agentx/actions/<id>.json`. The runner returns the same shape
// the CLI prints, capped at 32KB per stream.

async function upsertAction(body: any) {
  const { ActionStore } = await import("@/actions/store")
  const { actionSchema } = await import("@/actions/types")
  if (!body || typeof body !== "object") throw new Error("body required")
  const parsed = actionSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`${issue.path.join(".") || "<root>"}: ${issue.message}`)
  }
  const saved = new ActionStore().save(parsed.data)
  return { summary: `action "${saved.id}" saved (${saved.kind})`, action: saved }
}

async function deleteAction(body: any) {
  const { ActionStore } = await import("@/actions/store")
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("id required")
  if (!new ActionStore().delete(id)) throw new Error(`action "${id}" not found`)
  return { summary: `action "${id}" removed` }
}

async function runActionFromAdmin(body: any) {
  const { ActionStore } = await import("@/actions/store")
  const { runAction } = await import("@/actions/runner")
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("id required")
  const action = new ActionStore().get(id)
  if (!action) throw new Error(`action "${id}" not found`)
  const inputs = (body?.inputs && typeof body.inputs === "object") ? body.inputs as Record<string, unknown> : {}
  const result = await runAction(action, inputs)
  return { summary: `action "${id}" ${result.ok ? "ok" : "failed"} (${result.durationMs}ms)`, result }
}

// ========================================================================
// Mesh health-check cadence — admin write handler
// ========================================================================

async function updateMeshHealth(body: any) {
  const interval = body?.interval !== undefined ? Number(body.interval) : undefined
  const timeout = body?.timeout !== undefined ? Number(body.timeout) : undefined
  if (interval !== undefined && (!Number.isFinite(interval) || interval < 5 || interval > 3600)) {
    throw new Error("interval must be 5..3600 seconds")
  }
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 1 || timeout > 60)) {
    throw new Error("timeout must be 1..60 seconds")
  }
  if (interval === undefined && timeout === undefined) throw new Error("nothing to update")
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.mesh = cfg.mesh || {}
    cfg.mesh.healthCheck = cfg.mesh.healthCheck || {}
    if (interval !== undefined) cfg.mesh.healthCheck.interval = interval
    if (timeout !== undefined) cfg.mesh.healthCheck.timeout = timeout
    return `mesh.healthCheck updated (interval=${cfg.mesh.healthCheck.interval}s, timeout=${cfg.mesh.healthCheck.timeout}s)`
  })
  return { summary }
}

// ========================================================================
// Notifications — admin write handler (mirrors `agentx notifications`)
// ========================================================================

async function updateNotifications(body: any) {
  const { summary } = mutateAgentxConfig((cfg) => {
    cfg.notifications = cfg.notifications || {}
    const changes: string[] = []
    if (body && typeof body === "object") {
      if ("destination" in body) {
        if (!body.destination) {
          delete cfg.notifications.destination
          changes.push("destination cleared")
        } else if (body.destination.channel && body.destination.chatId) {
          cfg.notifications.destination = {
            channel: String(body.destination.channel),
            chatId: String(body.destination.chatId),
            ...(body.destination.accountId ? { accountId: String(body.destination.accountId) } : {}),
          }
          changes.push(`destination=${body.destination.channel}:${body.destination.chatId}`)
        } else {
          throw new Error("destination requires channel + chatId")
        }
      }
      if ("on" in body && body.on && typeof body.on === "object") {
        cfg.notifications.on = cfg.notifications.on || {}
        for (const k of ["taskComplete", "taskError", "taskQueued"]) {
          if (k in body.on) cfg.notifications.on[k] = !!body.on[k]
        }
        changes.push("on=" + JSON.stringify(cfg.notifications.on))
      }
      if ("longTaskThreshold" in body) {
        const n = Number(body.longTaskThreshold)
        if (!Number.isFinite(n) || n < 0) throw new Error("longTaskThreshold must be a non-negative number")
        cfg.notifications.longTaskThreshold = n
        changes.push(`threshold=${n}s`)
      }
    }
    if (changes.length === 0) throw new Error("nothing to update")
    return `notifications updated (${changes.join(", ")})`
  })
  return { summary }
}

// ========================================================================
// Webhook triggers — granular event-type → workflow id mapping
// ========================================================================

async function updateWebhookTriggers(body: any) {
  const id = String(body?.id || "").trim()
  if (!id) throw new Error("webhook id required")
  const { summary } = mutateAgentxConfig((cfg) => {
    const list = Array.isArray(cfg.webhooks) ? cfg.webhooks : []
    const w = list.find((x: any) => x.id === id)
    if (!w) throw new Error(`webhook "${id}" not found`)
    if ("triggers" in body) {
      if (body.triggers === null || (typeof body.triggers === "object" && Object.keys(body.triggers).length === 0)) {
        delete w.triggers
      } else if (typeof body.triggers === "object") {
        // shape check — keys are event names (free-form), values are workflow ids
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(body.triggers as Record<string, unknown>)) {
          if (typeof v === "string" && v.trim()) out[String(k)] = v.trim()
        }
        if (Object.keys(out).length === 0) delete w.triggers
        else w.triggers = out
      }
    }
    if ("defaultWorkflow" in body) {
      if (!body.defaultWorkflow) delete w.defaultWorkflow
      else w.defaultWorkflow = String(body.defaultWorkflow).trim()
    }
    return `webhook "${id}" triggers/defaultWorkflow updated`
  })
  return { summary }
}

// Keep reference so unused-import linters don't trip. rmSync is wired for a
// future "delete workspace too" feature; for now the admin panel never deletes
// files on disk, only config entries.
export const _reserved = { rmSync }

// ========================================================================
// HTML
// ========================================================================

