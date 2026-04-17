import { existsSync, readFileSync, writeFileSync, rmSync } from "fs"
import { resolve } from "path"
import type { IncomingMessage, ServerResponse } from "http"
import { mutateAgentxConfig } from "./config-mutate"
import { TokenStore } from "./token-store"
import { loadDaemonConfig } from "./config"
import { listAgentFiles, readAgentFile, writeAgentFile, createAgentSkill, deleteAgentSkill } from "./file-ops"
import { getWhatsAppState } from "./whatsapp-state"

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

export function handleAdminGet(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(renderAdminHtml())
}

export async function handleAdminConfigGet(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = readConfigRaw()
  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify(cfg))
}

export async function handleAdminApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  try {
    // Non-JSON carve-out: the WhatsApp QR rendered as SVG.
    if (req.method === "GET" && path === "/api/admin/channels/whatsapp/qr.svg") {
      await serveWhatsAppQRSvg(res)
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
      "GET /api/admin/channels/whatsapp/state": () => getWhatsAppState(),
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
      botTokenRef: acc.botToken || "",
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
  })) : []
  const mesh = {
    enabled: !!cfg.mesh?.enabled,
    discovery: cfg.mesh?.discovery || "static",
    peers: (cfg.mesh?.peers || []).map((p: any) => ({
      url: p.url,
      name: p.name,
      hasToken: !!p.token,
    })),
  }
  // Daemon URL — used by the admin UI to compose full webhook URLs for copy.
  const daemonUrl = cfg.dashboard?.daemonUrl || "http://localhost:18800"
  return { exists: true, agents, telegram, slack, discord, gitlab, whatsapp, crons, webhooks, mesh, daemonUrl, nodeName: cfg.node?.name }
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
      require("fs").mkdirSync(workspace, { recursive: true })
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
    cfg.channels.telegram.accounts[id] = {
      botToken: "${" + botTokenEnv + "}",
      botUsername,
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
      acc.botToken = "${" + patch.botTokenEnv.trim() + "}"
    }
    return `updated telegram account "${id}"`
  })
  return { summary }
}

/**
 * Render the current WhatsApp QR string as an SVG the browser can consume.
 * Returns 204 No Content when no QR is pending (connected / logged out /
 * waiting) so an <img> element just keeps polling without showing a broken
 * picture frame. `qrcode` is a lazy import — a truly minimal install without
 * that dep still boots the daemon.
 */
async function serveWhatsAppQRSvg(res: ServerResponse): Promise<void> {
  const s = getWhatsAppState()
  if (!s.qr) {
    res.writeHead(204, { "Cache-Control": "no-store" })
    res.end()
    return
  }
  let QRCode: any
  try {
    // @ts-ignore — qrcode ships without types; we use toString at runtime
    const mod = await import("qrcode")
    QRCode = (mod as any).default || mod
  } catch {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("qrcode package not installed — run `npm install qrcode` inside the daemon's dir")
    return
  }
  try {
    const svg: string = await QRCode.toString(s.qr, {
      type: "svg",
      errorCorrectionLevel: "L",
      margin: 1,
      color: { dark: "#000", light: "#fff" },
    })
    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    })
    res.end(svg)
  } catch (e: any) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("QR render failed: " + (e?.message || "unknown"))
  }
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
    try { require("fs").copyFileSync(file, backupPath) } catch { /* best-effort */ }
  }
  writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n", "utf-8")
  // Best-effort /reload; caller can also restart the daemon.
  try {
    const { loadDaemonConfig } = require("./config")
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

// Keep reference so unused-import linters don't trip. rmSync is wired for a
// future "delete workspace too" feature; for now the admin panel never deletes
// files on disk, only config entries.
export const _reserved = { rmSync }

// ========================================================================
// HTML
// ========================================================================

function renderAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentX · Settings</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
/* --- Design tokens (ops-daemon, matches /live) --- */
:root{
  --ax-bg:oklch(0.16 0.010 265);--ax-bg-elev:oklch(0.19 0.012 265);
  --ax-surface:oklch(0.21 0.012 265);--ax-surface-2:oklch(0.24 0.014 265);
  --ax-border:oklch(0.29 0.014 265);--ax-border-2:oklch(0.35 0.016 265);
  --ax-text:oklch(0.95 0.005 265);--ax-text-2:oklch(0.80 0.008 265);
  --ax-muted:oklch(0.60 0.010 265);
  --ax-accent:oklch(0.78 0.13 165);--ax-warn:oklch(0.80 0.14 75);
  --ax-err:oklch(0.68 0.19 25);--ax-info:oklch(0.78 0.10 220);
  --ax-font:"IBM Plex Sans",-apple-system,"Segoe UI",sans-serif;
  --ax-mono:"IBM Plex Mono",ui-monospace,"SF Mono",Consolas,monospace;
  /* Legacy aliases so existing class names inherit the new palette. */
  --bg:var(--ax-bg);--card:var(--ax-surface);--border:var(--ax-border);
  --text:var(--ax-text);--muted:var(--ax-muted);--accent:var(--ax-accent);
  --green:var(--ax-accent);--red:var(--ax-err);--yellow:var(--ax-warn);
  color-scheme:dark;
}
[data-theme="light"]{--ax-bg:oklch(0.98 0.002 265);--ax-bg-elev:oklch(0.96 0.003 265);
  --ax-surface:oklch(0.99 0.002 265);--ax-surface-2:oklch(0.955 0.003 265);
  --ax-border:oklch(0.88 0.006 265);--ax-border-2:oklch(0.78 0.008 265);
  --ax-text:oklch(0.22 0.010 265);--ax-text-2:oklch(0.36 0.010 265);
  --ax-muted:oklch(0.54 0.010 265);--ax-accent:oklch(0.55 0.14 165);color-scheme:light}
[data-theme="crt"]{--ax-bg:#05140a;--ax-bg-elev:#061a0d;--ax-surface:#08201f;
  --ax-surface-2:#0b2922;--ax-border:#164a30;--ax-border-2:#1f6a44;
  --ax-text:#b7ffcc;--ax-text-2:#83e3a8;--ax-muted:#4f9a73;--ax-accent:#6dff9e;
  --ax-font:"IBM Plex Mono",ui-monospace,monospace}
.ax-theme-switch{display:inline-flex;border:1px solid var(--ax-border-2);
  border-radius:4px;overflow:hidden;margin-right:4px}
.ax-theme-switch button{background:transparent;border:none;color:var(--ax-muted);
  padding:3px 9px;font:inherit;font-size:10px;cursor:pointer;letter-spacing:0.04em;
  text-transform:uppercase;font-family:var(--ax-mono);border-right:1px solid var(--ax-border-2)}
.ax-theme-switch button:last-child{border-right:none}
.ax-theme-switch button:hover{color:var(--ax-text);background:var(--ax-surface-2)}
.ax-theme-switch button.is-active{color:var(--ax-accent);
  background:color-mix(in oklch,var(--ax-accent) 12%,var(--ax-surface))}
*{box-sizing:border-box}
html,body{margin:0;min-height:100vh;background:var(--ax-bg);color:var(--ax-text);
  font-family:var(--ax-font);font-size:13px;line-height:1.5;
  -webkit-font-smoothing:antialiased;font-feature-settings:"ss01","cv01"}
code,.mono{font-family:var(--ax-mono);font-variant-numeric:tabular-nums}

/* --- Topbar (ax-* mirrors /live) --- */
.ax-topbar{display:flex;align-items:center;justify-content:space-between;
  padding:8px 18px;border-bottom:1px solid var(--ax-border);
  background:var(--ax-bg-elev);position:sticky;top:0;z-index:20}
.ax-topbar__left{display:flex;align-items:center;gap:18px}
.ax-brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:-0.01em}
.ax-brand__mark{font-family:var(--ax-mono);font-size:12px;padding:2px 8px;
  border:1px solid var(--ax-border-2);color:var(--ax-accent);border-radius:4px}
.ax-brand__name{font-size:14px}
.ax-brand__subtitle{font-size:11px;color:var(--ax-muted);
  border-left:1px solid var(--ax-border);padding-left:12px;margin-left:4px}
.ax-topbar__tabs{display:flex;gap:2px}
.ax-topbar__tab{background:transparent;border:none;color:var(--ax-text-2);
  padding:8px 14px;font:inherit;cursor:pointer;font-size:12px;
  border-bottom:2px solid transparent;text-decoration:none;letter-spacing:-0.005em}
.ax-topbar__tab:hover{color:var(--ax-text)}
.ax-topbar__tab.is-active{color:var(--ax-text);border-bottom-color:var(--ax-accent)}

/* --- Inner tabs (Agents / Channels / Schedules / …) --- */
nav.tabs{display:flex;gap:4px;padding:14px 24px 0;background:var(--ax-bg-elev);
  border-bottom:1px solid var(--ax-border);overflow-x:auto}
nav.tabs button{background:transparent;border:none;color:var(--ax-muted);
  padding:8px 14px;font:inherit;font-size:12px;cursor:pointer;
  border-bottom:2px solid transparent;letter-spacing:-0.005em;
  border-top-left-radius:4px;border-top-right-radius:4px;
  transition:color 120ms,border-color 120ms,background 120ms}
nav.tabs button:hover{color:var(--ax-text);background:color-mix(in oklch,var(--ax-accent) 4%,transparent)}
nav.tabs button.active{color:var(--ax-text);border-bottom-color:var(--ax-accent);
  background:color-mix(in oklch,var(--ax-accent) 8%,transparent)}

main{max-width:960px;margin:0 auto;padding:20px 24px 60px}
section.tab{display:none}
section.tab.active{display:block}

h2{font-size:16px;margin:0 0 4px;font-weight:600;letter-spacing:-0.01em}
.lead{color:var(--ax-muted);margin:0 0 20px;font-size:12px;line-height:1.55;max-width:720px}

/* --- Row cards --- */
.list{display:flex;flex-direction:column;gap:6px;margin-bottom:22px}
.row-card{background:var(--ax-surface);border:1px solid var(--ax-border);
  border-radius:6px;padding:12px 14px;display:flex;align-items:center;gap:12px;
  transition:border-color 120ms}
.row-card:hover{border-color:var(--ax-border-2)}
.row-card .info{flex:1;min-width:0}
.row-card .info h3{margin:0 0 2px;font-size:13px;font-weight:600;letter-spacing:-0.005em}
.row-card .info .meta{font-size:11px;color:var(--ax-muted);font-family:var(--ax-mono);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.5}
.row-card .info .meta b{color:var(--ax-text);font-weight:500}
.row-card .info .meta a{color:var(--ax-accent)}

/* --- Buttons --- */
button.primary,button.ghost,button.danger{font-family:inherit;font-size:12px;cursor:pointer;
  border-radius:4px;transition:background 120ms,border-color 120ms,color 120ms}
button.primary{background:color-mix(in oklch,var(--ax-accent) 12%,var(--ax-surface));
  border:1px solid color-mix(in oklch,var(--ax-accent) 40%,var(--ax-border-2));
  color:var(--ax-accent);padding:6px 14px;font-weight:500}
button.primary:hover{background:color-mix(in oklch,var(--ax-accent) 20%,var(--ax-surface))}
button.primary:disabled{opacity:0.4;cursor:not-allowed}
button.ghost{background:var(--ax-surface);border:1px solid var(--ax-border-2);
  color:var(--ax-text);padding:6px 12px}
button.ghost:hover{background:var(--ax-surface-2);border-color:var(--ax-accent)}
button.danger{background:transparent;color:var(--ax-err);
  border:1px solid color-mix(in oklch,var(--ax-err) 35%,transparent);padding:5px 11px}
button.danger:hover{background:color-mix(in oklch,var(--ax-err) 10%,transparent);
  border-color:color-mix(in oklch,var(--ax-err) 55%,transparent)}

/* --- Forms --- */
.add-form{background:var(--ax-surface);border:1px solid var(--ax-border);
  border-radius:6px;padding:16px 18px;margin-top:8px}
.add-form h3{margin:0 0 10px;font-size:12px;font-weight:600;
  text-transform:uppercase;letter-spacing:0.06em;color:var(--ax-muted)}
label{display:block;margin:8px 0 4px;font-size:11px;color:var(--ax-muted);
  text-transform:uppercase;letter-spacing:0.04em}
label .hint{font-weight:400;font-size:11px;margin-left:6px;
  text-transform:none;letter-spacing:normal;color:var(--ax-muted);opacity:0.85}
input,textarea,select{width:100%;background:var(--ax-bg);color:var(--ax-text);
  border:1px solid var(--ax-border);border-radius:4px;padding:7px 10px;
  font:inherit;font-size:12px;transition:border-color 120ms}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--ax-accent)}
textarea{resize:vertical;min-height:64px;line-height:1.55}
textarea.raw{min-height:480px;font-family:var(--ax-mono);font-size:12px;line-height:1.6}

.rowf{display:flex;gap:10px}
.rowf > *{flex:1}
.actions{display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap}

/* --- Messages --- */
.msg{margin:10px 0;padding:8px 12px;border-radius:4px;font-size:12px;
  display:none;line-height:1.5}
.msg.ok{display:block;background:color-mix(in oklch,var(--ax-accent) 10%,transparent);
  color:var(--ax-accent);border:1px solid color-mix(in oklch,var(--ax-accent) 35%,transparent)}
.msg.err{display:block;background:color-mix(in oklch,var(--ax-err) 10%,transparent);
  color:var(--ax-err);border:1px solid color-mix(in oklch,var(--ax-err) 35%,transparent)}
.msg.warn{display:block;background:color-mix(in oklch,var(--ax-warn) 10%,transparent);
  color:var(--ax-warn);border:1px solid color-mix(in oklch,var(--ax-warn) 35%,transparent)}

.empty{color:var(--ax-muted);font-style:italic;padding:28px 12px;font-size:12px;
  text-align:center;border:1px dashed var(--ax-border);border-radius:4px}

/* --- Toggles + chips --- */
.toggle-switch{display:flex;align-items:center;gap:10px;margin-bottom:14px;font-size:12px}
.toggle-switch input{width:auto;accent-color:var(--ax-accent)}
.chip{display:inline-block;font-size:10px;padding:1px 7px;line-height:16px;
  border-radius:3px;background:var(--ax-surface);border:1px solid var(--ax-border);
  color:var(--ax-muted);font-family:var(--ax-mono);margin-right:4px;
  text-transform:uppercase;letter-spacing:0.02em}
.chip.off{background:var(--ax-surface-2);color:var(--ax-muted)}
.hint-block{font-size:11px;color:var(--ax-muted);margin-top:8px;line-height:1.55}
.hint-block code{background:var(--ax-bg);padding:1px 6px;border-radius:3px;
  color:var(--ax-text);font-family:var(--ax-mono);font-size:11px;
  border:1px solid var(--ax-border)}
.section-block{margin-bottom:28px}

/* --- Channels sidemenu --- */
.ch-split{display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start}
@media (max-width:720px){.ch-split{grid-template-columns:1fr}}
.ch-menu{background:var(--ax-surface);border:1px solid var(--ax-border);
  border-radius:6px;padding:6px;display:flex;flex-direction:column;gap:2px;
  position:sticky;top:120px}
.ch-menu button{background:transparent;border:1px solid transparent;
  color:var(--ax-text-2);padding:8px 10px;border-radius:4px;cursor:pointer;
  font:inherit;font-size:12px;text-align:left;display:flex;align-items:center;gap:10px;
  transition:background 120ms,border-color 120ms,color 120ms}
.ch-menu button:hover{background:var(--ax-surface-2);color:var(--ax-text)}
.ch-menu button.is-active{background:color-mix(in oklch,var(--ax-accent) 12%,var(--ax-surface));
  color:var(--ax-text);border-color:color-mix(in oklch,var(--ax-accent) 35%,var(--ax-border-2))}
.ch-menu .ch-icon{font-family:var(--ax-mono);font-size:10px;line-height:16px;
  width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;
  background:var(--ax-bg);border:1px solid var(--ax-border);border-radius:3px;
  color:var(--ax-muted);flex-shrink:0}
.ch-menu .ch-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ch-menu .ch-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:var(--ax-border-2)}
.ch-menu .ch-dot--on{background:var(--ax-accent)}
.ch-menu .ch-dot--off{background:var(--ax-warn)}
.ch-view{display:block}
.ch-view[hidden]{display:none}

/* --- Files modal --- */
.files-split{display:flex;flex:1;min-height:0}
.files-picker{width:260px;min-width:220px;border-right:1px solid var(--ax-border);
  overflow-y:auto;padding:10px 8px;background:var(--ax-bg-elev)}
.files-picker .group{font-size:10px;text-transform:uppercase;letter-spacing:0.06em;
  color:var(--ax-muted);padding:8px 10px 4px;font-weight:600}
.files-picker .file{display:flex;align-items:center;gap:8px;padding:8px 10px;
  border-radius:4px;cursor:pointer;font-size:12px;color:var(--ax-text);
  border-left:2px solid transparent;transition:background 120ms}
.files-picker .file:hover{background:color-mix(in oklch,var(--ax-accent) 6%,transparent)}
.files-picker .file.active{background:color-mix(in oklch,var(--ax-accent) 12%,transparent);
  border-left-color:var(--ax-accent);color:var(--ax-text)}
.files-picker .file.missing{color:var(--ax-muted);font-style:italic}
.files-picker .file .info{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files-picker .file .size{font-size:10px;color:var(--ax-muted);font-family:var(--ax-mono)}
.files-picker .file .del{background:transparent;border:none;color:var(--ax-muted);
  cursor:pointer;padding:0 4px;font-size:13px}
.files-picker .file .del:hover{color:var(--ax-err)}
.files-editor{flex:1;display:flex;flex-direction:column;overflow:hidden}
.files-editor-empty{flex:1;display:flex;align-items:center;justify-content:center;
  color:var(--ax-muted);font-style:italic;padding:40px;text-align:center;font-size:12px}
.files-editor-head{padding:10px 16px;border-bottom:1px solid var(--ax-border);
  display:flex;align-items:center;gap:10px;background:var(--ax-bg-elev)}
.files-editor-head .path{flex:1;font-family:var(--ax-mono);font-size:12px;color:var(--ax-muted)}
.files-editor-body{flex:1;overflow:hidden;display:flex}
.files-editor-body textarea{flex:1;background:var(--ax-bg);color:var(--ax-text);
  border:none;padding:14px 16px;font-family:var(--ax-mono);font-size:12px;line-height:1.6;resize:none}
.files-editor-body textarea:focus{outline:none}
.files-add{border-top:1px solid var(--ax-border);padding:10px 16px;background:var(--ax-bg-elev)}
.files-add h4{margin:0 0 8px;font-size:11px;font-weight:600;color:var(--ax-muted);
  text-transform:uppercase;letter-spacing:0.06em}

/* --- Test drive chat modal --- */
.td-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;
  justify-content:center;padding:24px}
.td-modal.hidden{display:none}
.td-backdrop{position:absolute;inset:0;background:color-mix(in oklch,var(--ax-bg) 60%,black)}
.td-card{position:relative;width:min(640px,94vw);height:min(720px,90vh);
  background:var(--ax-surface);border:1px solid var(--ax-border-2);border-radius:8px;
  display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,0.5);overflow:hidden}
.td-card > header{display:flex;align-items:center;gap:10px;padding:12px 16px;
  border-bottom:1px solid var(--ax-border);background:var(--ax-bg-elev)}
.td-card > header h3{margin:0;font-size:14px;font-weight:600;flex:1;letter-spacing:-0.005em}
.td-card .chip-small{font-size:10px;padding:2px 7px;border-radius:3px;
  background:color-mix(in oklch,var(--ax-accent) 14%,transparent);
  color:var(--ax-accent);letter-spacing:0.04em;text-transform:uppercase;font-family:var(--ax-mono)}
.td-close{background:transparent;border:none;color:var(--ax-muted);font-size:22px;
  cursor:pointer;padding:0 6px;line-height:1}
.td-close:hover{color:var(--ax-text)}
.td-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;
  gap:10px;background:var(--ax-bg)}
.td-msg{max-width:82%;padding:8px 12px;border-radius:10px;font-size:13px;
  line-height:1.5;word-wrap:break-word;white-space:pre-wrap}
.td-msg.user{align-self:flex-end;
  background:color-mix(in oklch,var(--ax-accent) 75%,var(--ax-bg));
  color:var(--ax-bg);font-weight:500;border-bottom-right-radius:2px}
.td-msg.agent{align-self:flex-start;background:var(--ax-surface);color:var(--ax-text);
  border:1px solid var(--ax-border);border-bottom-left-radius:2px}
.td-msg.err{align-self:flex-start;background:color-mix(in oklch,var(--ax-err) 10%,transparent);
  color:var(--ax-err);border:1px solid color-mix(in oklch,var(--ax-err) 35%,transparent);
  border-bottom-left-radius:2px}
.td-msg.thinking{align-self:flex-start;color:var(--ax-muted);font-style:italic;
  background:transparent;padding:4px 8px}
.td-empty{color:var(--ax-muted);text-align:center;padding:40px 12px;font-style:italic;font-size:13px}
.td-footer{border-top:1px solid var(--ax-border);padding:10px 12px;display:flex;
  gap:8px;align-items:flex-end;background:var(--ax-bg-elev)}
.td-footer textarea{flex:1;background:var(--ax-bg);color:var(--ax-text);
  border:1px solid var(--ax-border);border-radius:4px;padding:8px 10px;
  font:inherit;font-size:13px;min-height:40px;max-height:120px;resize:none}
.td-footer textarea:focus{outline:none;border-color:var(--ax-accent)}
.td-footer button{background:color-mix(in oklch,var(--ax-accent) 20%,var(--ax-surface));
  color:var(--ax-accent);border:1px solid color-mix(in oklch,var(--ax-accent) 40%,var(--ax-border-2));
  border-radius:4px;padding:8px 16px;font-weight:500;font-size:13px;cursor:pointer}
.td-footer button:hover{background:color-mix(in oklch,var(--ax-accent) 28%,var(--ax-surface))}
.td-footer button:disabled{opacity:0.4;cursor:not-allowed}
.td-hint{padding:6px 16px;font-size:10px;color:var(--ax-muted);
  border-top:1px solid var(--ax-border);background:var(--ax-bg-elev);font-family:var(--ax-mono)}
</style>
<script>(function(){try{var t=localStorage.getItem('ax-theme')||'dark';document.documentElement.setAttribute('data-theme',t)}catch(e){}})();</script>
</head>
<body>
<header class="ax-topbar">
  <div class="ax-topbar__left">
    <div class="ax-brand">
      <span class="ax-brand__mark">AX</span>
      <span class="ax-brand__name">AgentX</span>
      <span class="ax-brand__subtitle">Settings</span>
    </div>
    <nav class="ax-topbar__tabs">
      <a href="/live" class="ax-topbar__tab">Live</a>
      <a href="/" class="ax-topbar__tab">Boards</a>
      <a href="/admin" class="ax-topbar__tab is-active">Settings</a>
      <a href="/glossary" class="ax-topbar__tab">Glossary</a>
    </nav>
  </div>
  <div class="ax-theme-switch" role="tablist" aria-label="Theme">
    <button data-theme-opt="dark">Dark</button>
    <button data-theme-opt="light">Light</button>
    <button data-theme-opt="crt">CRT</button>
  </div>
</header>
<nav class="tabs">
  <button data-tab="agents" class="active">Agents</button>
  <button data-tab="channels">Channels</button>
  <button data-tab="crons">Schedules</button>
  <button data-tab="webhooks">Webhooks</button>
  <button data-tab="mesh">Mesh</button>
  <button data-tab="tokens">Tokens</button>
  <button data-tab="advanced">Advanced</button>
</nav>
<div id="files-modal" class="td-modal hidden" aria-hidden="true">
  <div class="td-backdrop"></div>
  <div class="td-card" role="dialog" aria-modal="true" style="width:min(960px,94vw);height:min(720px,90vh)">
    <header>
      <span class="chip-small" id="files-tab-label">Identity</span>
      <h3 id="files-title">Agent · Files</h3>
      <nav style="display:flex;gap:0;margin-right:10px">
        <button class="ghost" id="files-tab-identity" style="padding:6px 12px;font-size:12px;border-top-right-radius:0;border-bottom-right-radius:0">Identity</button>
        <button class="ghost" id="files-tab-skills" style="padding:6px 12px;font-size:12px;border-top-left-radius:0;border-bottom-left-radius:0;border-left:none">Skills</button>
      </nav>
      <button class="td-close" id="files-close" aria-label="Close">×</button>
    </header>
    <div class="files-split">
      <aside class="files-picker" id="files-picker"></aside>
      <div class="files-editor">
        <div id="files-editor-empty" class="files-editor-empty">Pick a file on the left to open it.</div>
        <div id="files-editor-head" class="files-editor-head" style="display:none">
          <span class="path" id="files-current-path"></span>
          <label class="ghost" style="padding:6px 10px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;border:1px solid var(--ax-border-2);border-radius:4px">
            ↑ Upload<input type="file" id="files-upload" accept=".md,.markdown,.txt,text/markdown,text/plain" style="display:none" />
          </label>
          <button class="ghost" id="files-revert" style="padding:6px 10px;font-size:12px">Revert</button>
          <button class="primary" id="files-save" style="padding:6px 14px;font-size:12px">Save</button>
        </div>
        <div class="files-editor-body" style="display:none" id="files-editor-wrap">
          <textarea id="files-editor" spellcheck="false"></textarea>
        </div>
        <div id="files-save-msg" class="msg" style="margin:10px 16px"></div>

        <div id="files-add-skill" class="files-add" style="display:none">
          <h4>Add a skill</h4>
          <div class="rowf">
            <div><label>Slug<span class="hint">(lowercase)</span></label><input id="skill-slug" placeholder="my-skill" /></div>
            <div><label>Title<span class="hint">(optional)</span></label><input id="skill-title" placeholder="What the skill does" /></div>
          </div>
          <label>Upload SKILL.md<span class="hint">(optional — otherwise we scaffold a template)</span></label>
          <input id="skill-file" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" />
          <div class="actions"><button class="primary" onclick="addSkill()">Create</button><div id="skill-msg" class="msg"></div></div>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="tg-edit-modal" class="td-modal hidden" aria-hidden="true">
  <div class="td-backdrop"></div>
  <div class="td-card" role="dialog" aria-modal="true" style="height:auto;max-height:90vh;width:min(520px,94vw)">
    <header>
      <span class="chip-small">Edit</span>
      <h3 id="tg-edit-title">Telegram account</h3>
      <button class="td-close" id="tg-edit-close" aria-label="Close">×</button>
    </header>
    <div style="flex:1;overflow-y:auto;padding:16px 20px">
      <input type="hidden" id="tg-edit-id" />
      <label>Bind to agent</label>
      <select id="tg-edit-agent"></select>
      <label>Bot username<span class="hint">(optional)</span></label>
      <input id="tg-edit-user" placeholder="my_bot" />
      <label>Bot token env-var<span class="hint">(e.g. <code>TG_SUPPORT_BOT_TOKEN</code>)</span></label>
      <input id="tg-edit-env" placeholder="TG_SUPPORT_BOT_TOKEN" />
      <div class="hint-block">Token value stays in <code>.env</code>; this panel only edits the reference name.</div>
      <div id="tg-edit-msg" class="msg"></div>
    </div>
    <div class="td-footer" style="justify-content:flex-end">
      <button class="ghost" id="tg-edit-cancel" style="padding:7px 14px">Cancel</button>
      <button class="primary" id="tg-edit-save">Save changes</button>
    </div>
  </div>
</div>

<div id="edit-modal" class="td-modal hidden" aria-hidden="true">
  <div class="td-backdrop"></div>
  <div class="td-card" role="dialog" aria-modal="true" style="height:auto;max-height:90vh;width:min(560px,94vw)">
    <header>
      <span class="chip-small">Edit</span>
      <h3 id="edit-title">Agent</h3>
      <button class="td-close" id="edit-close" aria-label="Close">×</button>
    </header>
    <div style="flex:1;overflow-y:auto;padding:16px 20px">
      <div class="rowf">
        <div><label>Name</label><input id="e-name" /></div>
        <div><label>AI engine</label><select id="e-tier"><option value="claude-code">Claude Code</option><option value="sdk">Anthropic API (SDK)</option><option value="orchestrator">Orchestrator</option></select></div>
      </div>
      <label>Model<span class="hint">(optional)</span></label>
      <input id="e-model" />
      <label>Trigger words<span class="hint">(comma or space separated)</span></label>
      <input id="e-triggers" />
      <label>Personality / system prompt</label>
      <textarea id="e-personality" rows="5"></textarea>
      <div class="rowf">
        <div><label>Max concurrent tasks</label><input id="e-max-concurrent" type="number" min="1" max="20" /></div>
        <div><label>Max execution (minutes)</label><input id="e-max-exec" type="number" min="1" max="240" /></div>
      </div>
      <label>Permission mode<span class="hint">(default / bypassPermissions / plan)</span></label>
      <select id="e-perm"><option value="default">default</option><option value="bypassPermissions">bypassPermissions</option><option value="plan">plan</option></select>
      <label class="toggle-switch" style="margin-top:12px"><input type="checkbox" id="e-access" /> <span>Expose via public API</span></label>
      <div id="e-msg" class="msg"></div>
    </div>
    <div class="td-footer" style="justify-content:flex-end">
      <button class="ghost" id="edit-cancel" style="padding:7px 14px">Cancel</button>
      <button class="primary" id="edit-save">Save changes</button>
    </div>
  </div>
</div>
<div id="td-modal" class="td-modal hidden" aria-hidden="true">
  <div class="td-backdrop"></div>
  <div class="td-card" role="dialog" aria-modal="true">
    <header>
      <span class="chip-small">Test drive</span>
      <h3 id="td-title">Agent</h3>
      <button class="td-close" id="td-close" aria-label="Close">×</button>
    </header>
    <div id="td-body" class="td-body"><div class="td-empty">Send a message to sanity-check this agent before wiring it to a real channel.</div></div>
    <div class="td-footer">
      <textarea id="td-input" placeholder="Message the agent…  (Cmd/Ctrl-Enter to send)" rows="1"></textarea>
      <button id="td-send">Send</button>
    </div>
    <div class="td-hint" id="td-hint"></div>
  </div>
</div>
<main>
  <div id="global-msg" class="msg"></div>

  <section id="tab-agents" class="tab active">
    <h2>Agents</h2>
    <p class="lead">Each agent is a role with its own trigger words and folder. Delete removes the config only — the agent's folder stays on disk.</p>
    <div id="agent-list" class="list"></div>
    <div class="add-form">
      <h3>Add a new agent</h3>
      <div class="rowf">
        <div><label>Agent id<span class="hint">(lowercase)</span></label><input id="a-id" placeholder="sales" /></div>
        <div><label>Agent name</label><input id="a-name" placeholder="Sales Bot" /></div>
      </div>
      <label>Trigger words<span class="hint">(comma or space separated)</span></label>
      <input id="a-triggers" placeholder="@sales, sales" />
      <div class="rowf">
        <div><label>AI engine</label><select id="a-tier"><option value="claude-code">Claude Code</option><option value="sdk">Anthropic API (SDK)</option></select></div>
        <div><label>Model<span class="hint">(optional)</span></label><input id="a-model" placeholder="claude-sonnet-4-6" /></div>
      </div>
      <label>Personality / instructions<span class="hint">(optional)</span></label>
      <textarea id="a-personality" placeholder="You are a sales agent for Acme. Qualify leads, route pricing questions to @support."></textarea>
      <label class="toggle-switch" style="margin-top:12px"><input type="checkbox" id="a-public" /> <span>Expose via public API (needs a token with <code>agent:&lt;id&gt;</code> scope)</span></label>
      <div class="actions"><button class="primary" onclick="addAgent()">Add agent</button><div id="a-msg" class="msg"></div></div>
    </div>
  </section>

  <section id="tab-channels" class="tab">
    <h2>Channels</h2>
    <p class="lead">Everywhere agents can answer from. Pick a connector on the left to configure or check status.</p>
    <div class="ch-split">
      <aside class="ch-menu" id="ch-menu"></aside>
      <div class="ch-pane">
        <div id="ch-telegram" class="ch-view"><div id="tg-section" class="section-block"></div></div>
        <div id="ch-whatsapp" class="ch-view" hidden></div>
        <div id="ch-slack" class="ch-view" hidden><div id="slack-section" class="section-block"></div></div>
        <div id="ch-discord" class="ch-view" hidden></div>
        <div id="ch-gitlab" class="ch-view" hidden></div>
        <div id="ch-github" class="ch-view" hidden></div>
      </div>
    </div>
  </section>

  <section id="tab-crons" class="tab">
    <h2>Schedules</h2>
    <p class="lead">Recurring jobs that nudge an agent without a human trigger. Use cron syntax — e.g. <code>0 9 * * 1</code> for Mondays at 9am.</p>
    <div id="cron-list" class="list"></div>
    <div class="add-form">
      <h3>Add a schedule</h3>
      <div class="rowf">
        <div><label>Schedule id<span class="hint">(lowercase)</span></label><input id="c-id" placeholder="weekly-report" /></div>
        <div><label>Agent</label><select id="c-agent"></select></div>
      </div>
      <label>Cron expression<span class="hint">(<a href="https://crontab.guru/" target="_blank" style="color:var(--accent)">crontab.guru</a> can help)</span></label>
      <input id="c-schedule" placeholder="0 9 * * 1" />
      <div id="c-preview" class="hint-block" style="margin-top:4px;min-height:32px"></div>
      <label>Prompt<span class="hint">(what the agent should do on every tick)</span></label>
      <textarea id="c-prompt" placeholder="Send me the weekly sales summary."></textarea>
      <div class="actions"><button class="primary" onclick="addCron()">Add schedule</button><div id="c-msg" class="msg"></div></div>
    </div>
  </section>

  <section id="tab-webhooks" class="tab">
    <h2>Webhooks</h2>
    <p class="lead">Each webhook is an inbound URL an external service POSTs to. We translate the payload into a readable message and route it to the agent you bind here. Defaults: GitLab, GitHub, Sentry, Stripe, Discord, Slack, custom.</p>
    <div id="webhook-list" class="list"></div>
    <div class="add-form">
      <h3>Add a webhook</h3>
      <div class="rowf">
        <div><label>Webhook id<span class="hint">(lowercase)</span></label><input id="w-id" placeholder="mtgl-gitlab" /></div>
        <div><label>Source</label><select id="w-source"><option value="gitlab">GitLab</option><option value="github">GitHub</option><option value="sentry">Sentry</option><option value="stripe">Stripe</option><option value="discord">Discord</option><option value="slack">Slack</option><option value="custom">Custom</option></select></div>
      </div>
      <div class="rowf">
        <div><label>Agent</label><select id="w-agent"></select></div>
        <div><label>Signing secret env-var<span class="hint">(optional)</span></label><input id="w-secret" placeholder="GITLAB_WEBHOOK_SECRET" /></div>
      </div>
      <label>Description<span class="hint">(optional)</span></label>
      <input id="w-desc" placeholder="MTGL main project webhooks" />
      <div class="actions"><button class="primary" onclick="addWebhook()">Add webhook</button><div id="w-msg" class="msg"></div></div>
    </div>
  </section>

  <section id="tab-mesh" class="tab">
    <h2>Mesh — team network</h2>
    <p class="lead">Link AgentX instances across machines so they share work. Each peer is another daemon's URL; an optional token secures the connection.</p>
    <div class="toggle-switch"><input type="checkbox" id="mesh-toggle" /> <label for="mesh-toggle" style="color:var(--text);margin:0">Mesh enabled on this node</label></div>
    <div id="mesh-peers" class="list"></div>
    <div class="add-form">
      <h3>Add a peer</h3>
      <div class="rowf">
        <div><label>Peer name<span class="hint">(human label)</span></label><input id="m-name" placeholder="clawd-server" /></div>
        <div><label>URL</label><input id="m-url" placeholder="http://192.168.1.50:18800" /></div>
      </div>
      <label>Auth token<span class="hint">(optional — use a scoped token with <code>mesh:peer</code>)</span></label>
      <input id="m-token" type="password" />
      <div class="actions"><button class="primary" onclick="addMeshPeer()">Add peer</button><div id="m-msg" class="msg"></div></div>
    </div>
  </section>

  <section id="tab-tokens" class="tab">
    <h2>Access tokens</h2>
    <p class="lead">Scoped tokens let external apps and mesh peers call AgentX. Pick the narrowest scope that covers what the caller needs — tokens can't be recovered if leaked, so short expiries are a good habit.</p>
    <div id="token-list" class="list"></div>
    <div class="add-form">
      <h3>Mint a new token</h3>
      <label>Name<span class="hint">(who or what this is for — e.g. "Slack bridge", "Mesh peer: laptop")</span></label>
      <input id="t-name" placeholder="Slack bridge" />
      <label>Scopes<span class="hint">(pick one or more)</span></label>
      <div id="t-scopes" style="display:flex;flex-direction:column;gap:4px;margin-top:4px"></div>
      <label>Expires after<span class="hint">(in days; blank = never)</span></label>
      <input id="t-expires" type="number" min="1" max="3650" placeholder="90" />
      <div class="actions"><button class="primary" onclick="createToken()">Create token</button><div id="t-msg" class="msg"></div></div>
      <div id="t-reveal" style="display:none;margin-top:14px;padding:14px 16px;border-radius:6px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3)">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Copy this now — it won't be shown again.</div>
        <code id="t-secret" style="display:block;word-break:break-all;color:var(--green);font-family:ui-monospace,monospace;font-size:12px;padding:8px;background:#0e1119;border-radius:4px"></code>
      </div>
    </div>
  </section>

  <section id="tab-advanced" class="tab">
    <h2>Advanced — raw agentx.json</h2>
    <p class="lead">Direct editor for the full config. Saving creates a timestamped backup so you can roll back. After a save, the daemon is asked to hot-reload — if a field needs a restart, you'll see it in the dashboard.</p>
    <textarea id="raw-editor" class="raw" spellcheck="false"></textarea>
    <div class="actions">
      <button class="primary" onclick="saveRaw()">Save config</button>
      <button class="ghost" onclick="loadRaw()">Reload from disk</button>
      <div id="r-msg" class="msg"></div>
    </div>
    <div class="hint-block">The schema is documented at <code>docs/reference/config-schema.md</code>. Invalid JSON is refused; schema-level errors only surface after the daemon tries to use the new config.</div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let state = null;

async function req(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agentx-admin' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function showMsg(el, kind, text) {
  el.className = 'msg ' + kind;
  el.textContent = text;
  if (kind === 'ok') setTimeout(() => { el.className = 'msg'; el.textContent = ''; }, 4000);
}

async function refresh() {
  try {
    state = await req('GET', '/api/admin/state');
    if (!state.exists) {
      showMsg($('global-msg'), 'warn', 'No agentx.json found. Run the setup wizard first.');
      return;
    }
    renderAgents();
    renderChannels();
    renderCrons();
    renderWebhooks();
    renderMesh();
  } catch (e) {
    showMsg($('global-msg'), 'err', e.message);
  }
}

function renderWebhooks() {
  const list = $('webhook-list');
  const daemonUrl = (state.daemonUrl || '').replace(/\\/+$/, '');
  const sources = {
    gitlab: { icon: '🦊', label: 'GitLab', hint: 'In GitLab → Settings → Webhooks; tick Push events, Issue events, Pipeline events.' },
    github: { icon: '🐙', label: 'GitHub', hint: 'In GitHub → Repo Settings → Webhooks; pick individual events.' },
    sentry: { icon: '🛡', label: 'Sentry', hint: 'In Sentry → Project Settings → Alerts → Webhooks.' },
    stripe: { icon: '💳', label: 'Stripe', hint: 'In Stripe Dashboard → Developers → Webhooks.' },
    discord: { icon: '💬', label: 'Discord', hint: 'In Discord → Channel Settings → Integrations → Webhooks.' },
    slack: { icon: '#️⃣', label: 'Slack', hint: 'Slack Outgoing Webhooks / Events API — point at the URL below.' },
    custom: { icon: '🔗', label: 'Custom', hint: 'Any service that can POST JSON — the payload is forwarded as-is.' },
  };
  if (!state.webhooks.length) {
    list.innerHTML = '<div class="empty">No webhooks registered.</div>';
  } else {
    list.innerHTML = '';
    for (const w of state.webhooks) {
      const meta = sources[w.source] || sources.custom;
      const url = daemonUrl + '/webhook/' + encodeURIComponent(w.agentId) + '/' + encodeURIComponent(w.source);
      const div = document.createElement('div');
      div.className = 'row-card';
      div.style.flexWrap = 'wrap';
      div.style.gap = '10px';
      const statusChip = w.enabled
        ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--green)">enabled</span>'
        : '<span class="chip off">disabled</span>';
      div.innerHTML =
        '<div class="info" style="min-width:240px"><h3>' + meta.icon + ' ' + escapeHtml(w.id) + '</h3>' +
          '<div class="meta">' + statusChip +
            '<span class="chip">' + escapeHtml(meta.label) + '</span>' +
            'agent: <b>' + escapeHtml(w.agentId) + '</b>' +
            (w.secretEnv ? ' · secret: <code style="font-family:ui-monospace,monospace">$\{' + escapeHtml(w.secretEnv) + '}</code>' : '') +
            (w.description ? '<br><span style="color:var(--muted)">' + escapeHtml(w.description) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div style="flex:1;min-width:300px">' +
          '<code style="display:block;font-family:ui-monospace,monospace;font-size:11px;background:#0e1119;padding:8px 10px;border-radius:4px;word-break:break-all">' + escapeHtml(url) + '</code>' +
          '<div style="font-size:10px;color:var(--muted);margin-top:4px">' + escapeHtml(meta.hint) + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px">' +
          '<button class="ghost" data-copy="' + escapeHtml(url) + '">Copy URL</button>' +
          '<button class="ghost" data-toggle-wh="' + escapeHtml(w.id) + '" data-enabled="' + (w.enabled ? '1' : '0') + '">' + (w.enabled ? 'Disable' : 'Enable') + '</button>' +
          '<button class="danger" data-rm-wh="' + escapeHtml(w.id) + '">Delete</button>' +
        '</div>';
      div.querySelector('button[data-copy]').addEventListener('click', (e) => {
        navigator.clipboard.writeText(e.currentTarget.dataset.copy).then(() => {
          const b = e.currentTarget; const old = b.textContent;
          b.textContent = 'Copied'; setTimeout(() => { b.textContent = old; }, 1200);
        });
      });
      div.querySelector('button[data-rm-wh]').addEventListener('click', () => deleteWebhookAction(w.id));
      div.querySelector('button[data-toggle-wh]').addEventListener('click', () => toggleWebhook(w.id, !w.enabled));
      list.appendChild(div);
    }
  }
  // Refresh the add-webhook agent picker.
  const sel = $('w-agent');
  const cur = sel.value;
  sel.innerHTML = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  if (cur) sel.value = cur;
}

async function addWebhook() {
  const body = {
    id: $('w-id').value.trim(),
    source: $('w-source').value,
    agentId: $('w-agent').value,
    secretEnv: $('w-secret').value.trim(),
    description: $('w-desc').value.trim(),
  };
  try {
    const r = await req('POST', '/api/admin/webhooks', body);
    showMsg($('w-msg'), 'ok', r.summary);
    $('w-id').value = ''; $('w-secret').value = ''; $('w-desc').value = '';
    refresh();
  } catch (e) { showMsg($('w-msg'), 'err', e.message); }
}

async function deleteWebhookAction(id) {
  if (!confirm('Delete webhook "' + id + '"?')) return;
  try { await req('DELETE', '/api/admin/webhooks', { id }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

async function toggleWebhook(id, enabled) {
  try { await req('PATCH', '/api/admin/webhooks', { id, patch: { enabled } }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

function renderMesh() {
  const m = state.mesh || { enabled: false, peers: [] };
  $('mesh-toggle').checked = !!m.enabled;
  const peers = $('mesh-peers');
  if (!m.peers.length) {
    peers.innerHTML = '<div class="empty">No mesh peers.</div>';
  } else {
    peers.innerHTML = '';
    for (const p of m.peers) {
      const div = document.createElement('div');
      div.className = 'row-card';
      div.innerHTML =
        '<div class="info"><h3>' + escapeHtml(p.name) + '</h3>' +
          '<div class="meta">' +
            (p.hasToken ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--green)">authenticated</span>' : '<span class="chip off">no token</span>') +
            '<code style="font-family:ui-monospace,monospace">' + escapeHtml(p.url) + '</code>' +
          '</div>' +
        '</div>' +
        '<button class="danger" data-rm-peer="' + escapeHtml(p.url) + '">Remove</button>';
      div.querySelector('button[data-rm-peer]').addEventListener('click', () => removeMeshPeer(p.url));
      peers.appendChild(div);
    }
  }
}

$('mesh-toggle').addEventListener('change', async (e) => {
  try { await req('POST', '/api/admin/mesh/toggle', { enabled: e.target.checked }); refresh(); }
  catch (err) { showMsg($('global-msg'), 'err', err.message); e.target.checked = !e.target.checked; }
});

async function addMeshPeer() {
  const body = { url: $('m-url').value.trim(), name: $('m-name').value.trim(), token: $('m-token').value.trim() };
  try {
    const r = await req('POST', '/api/admin/mesh/peers', body);
    showMsg($('m-msg'), 'ok', r.summary);
    $('m-url').value = ''; $('m-name').value = ''; $('m-token').value = '';
    refresh();
  } catch (e) { showMsg($('m-msg'), 'err', e.message); }
}

async function removeMeshPeer(url) {
  if (!confirm('Remove mesh peer at ' + url + '?')) return;
  try { await req('DELETE', '/api/admin/mesh/peers', { url }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

function renderAgents() {
  const list = $('agent-list');
  if (!state.agents.length) { list.innerHTML = '<div class="empty">No agents yet.</div>'; return; }
  list.innerHTML = '';
  for (const a of state.agents) {
    const div = document.createElement('div');
    div.className = 'row-card';
    const accessChip = a.access === 'public'
      ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--green)">public API</span>'
      : '<span class="chip off">private</span>';
    div.innerHTML =
      '<div class="info"><h3>' + escapeHtml(a.name) + '</h3>' +
        '<div class="meta">' +
          '<span class="chip">' + escapeHtml(a.tier || '') + '</span>' +
          (a.model ? '<span class="chip">' + escapeHtml(a.model) + '</span>' : '') +
          accessChip +
          '<b>' + escapeHtml(a.id) + '</b> · triggers: ' + (a.mentions.map(escapeHtml).join(', ') || '—') +
        '</div>' +
      '</div>' +
      '<button class="primary" data-test="' + escapeHtml(a.id) + '" data-name="' + escapeHtml(a.name) + '" style="margin-right:6px;padding:6px 12px;font-size:12px">Test drive</button>' +
      '<button class="ghost" data-edit="' + escapeHtml(a.id) + '" style="margin-right:6px">Edit</button>' +
      '<button class="ghost" data-files="' + escapeHtml(a.id) + '" data-name="' + escapeHtml(a.name) + '" style="margin-right:6px">Files</button>' +
      '<button class="ghost" data-toggle="' + escapeHtml(a.id) + '" data-access="' + escapeHtml(a.access) + '" style="margin-right:6px">' + (a.access === 'public' ? 'Make private' : 'Make public') + '</button>' +
      '<button class="danger" data-id="' + escapeHtml(a.id) + '">Delete</button>';
    div.querySelector('button.danger').addEventListener('click', () => deleteAgent(a.id));
    div.querySelector('button.ghost[data-toggle]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const want = btn.dataset.access === 'public' ? 'private' : 'public';
      setAgentAccess(btn.dataset.toggle, want);
    });
    div.querySelector('button[data-test]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      openTestDrive(btn.dataset.test, btn.dataset.name);
    });
    div.querySelector('button[data-edit]').addEventListener('click', () => openAgentEdit(a));
    div.querySelector('button[data-files]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      openFilesModal(btn.dataset.files, btn.dataset.name);
    });
    list.appendChild(div);
  }
  // Refresh the cron agent picker so new agents show up.
  const sel = $('c-agent');
  const current = sel.value;
  sel.innerHTML = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  if (current) sel.value = current;
}

async function addAgent() {
  const body = {
    id: $('a-id').value.trim(),
    name: $('a-name').value.trim(),
    triggerWords: $('a-triggers').value.trim(),
    tier: $('a-tier').value,
    model: $('a-model').value.trim() || undefined,
    personality: $('a-personality').value.trim() || undefined,
    access: $('a-public').checked ? 'public' : 'private',
  };
  try {
    const r = await req('POST', '/api/admin/agents', body);
    if (body.access === 'public') {
      await req('POST', '/api/admin/agents/access', { id: body.id, access: 'public' }).catch(() => {});
    }
    showMsg($('a-msg'), 'ok', r.summary || 'Added.');
    $('a-id').value = ''; $('a-name').value = ''; $('a-triggers').value = ''; $('a-personality').value = '';
    $('a-public').checked = false;
    refresh();
  } catch (e) { showMsg($('a-msg'), 'err', e.message); }
}

async function setAgentAccess(id, access) {
  try {
    await req('POST', '/api/admin/agents/access', { id, access });
    refresh();
  } catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

async function deleteAgent(id) {
  if (!confirm('Delete agent "' + id + '"? The config entry is removed; the workspace folder on disk is kept.')) return;
  try { await req('DELETE', '/api/admin/agents', { id }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

function renderChannels() {
  renderChannelsMenu();
  const t = state.telegram || { enabled: false, accounts: [] };
  const agentOptions = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  const accountRows = t.accounts.length === 0
    ? '<div class="empty">No Telegram accounts yet.</div>'
    : t.accounts.map((acc) =>
      '<div class="row-card"><div class="info"><h3>' + escapeHtml(acc.id) + '</h3>' +
      '<div class="meta">' +
        '<span class="chip ' + (t.enabled ? '' : 'off') + '">' + (t.enabled ? 'enabled' : 'disabled') + '</span>' +
        'bot: <b>' + escapeHtml(acc.botUsername || '—') + '</b> · agent: <b>' + escapeHtml(acc.agentBinding || '—') + '</b> · token ref: <b>' + escapeHtml(acc.botTokenRef || '—') + '</b>' +
      '</div></div>' +
      '<button class="ghost" data-tg-edit="' + escapeHtml(acc.id) + '" style="margin-right:6px">Edit</button>' +
      '<button class="danger" data-id="' + escapeHtml(acc.id) + '">Delete</button></div>').join('');
  $('tg-section').innerHTML =
    '<div class="toggle-switch"><input type="checkbox" id="tg-toggle"' + (t.enabled ? ' checked' : '') + ' /><label for="tg-toggle" style="color:var(--text);margin:0">Telegram connector enabled</label></div>' +
    '<div class="list">' + accountRows + '</div>' +
    '<div class="add-form"><h3>Add a Telegram account</h3>' +
      '<div class="rowf"><div><label>Account id<span class="hint">(e.g. support)</span></label><input id="tg-id" /></div>' +
      '<div><label>Bind to agent</label><select id="tg-agent">' + agentOptions + '</select></div></div>' +
      '<label>Bot username<span class="hint">(optional)</span></label><input id="tg-user" placeholder="my_bot" />' +
      '<label>Bot token env-var<span class="hint">(name of the <code>.env</code> variable holding the token)</span></label><input id="tg-env" placeholder="TG_SUPPORT_BOT_TOKEN" />' +
      '<div class="actions"><button class="primary" onclick="addTelegram()">Add account</button><div id="tg-msg" class="msg"></div></div>' +
      '<div class="hint-block">We reference the token as <code>\${TG_..._BOT_TOKEN}</code> in <code>agentx.json</code>. The actual value lives in <code>.env</code> — this panel never reads or transmits it.</div>' +
    '</div>';
  $('tg-toggle').addEventListener('change', async (e) => {
    try { await req('POST', '/api/admin/channels/telegram/toggle', { enabled: e.target.checked }); refresh(); }
    catch (err) { showMsg($('global-msg'), 'err', err.message); }
  });
  for (const btn of document.querySelectorAll('#tg-section button.danger')) {
    btn.addEventListener('click', () => deleteTelegram(btn.dataset.id));
  }
  for (const btn of document.querySelectorAll('#tg-section button[data-tg-edit]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tgEdit;
      const acc = (state.telegram.accounts || []).find((a) => a.id === id);
      if (acc) openTelegramEdit(acc);
    });
  }
  renderSlackSection();
}

const CHANNEL_DEFS = [
  { id: 'telegram', icon: 'TG', label: 'Telegram' },
  { id: 'whatsapp', icon: 'WA', label: 'WhatsApp' },
  { id: 'slack',    icon: 'SL', label: 'Slack' },
  { id: 'discord',  icon: 'DC', label: 'Discord' },
  { id: 'gitlab',   icon: 'GL', label: 'GitLab' },
  { id: 'github',   icon: 'GH', label: 'GitHub' },
];

function channelStatus(id) {
  if (id === 'telegram') {
    const t = state.telegram || {};
    const configured = (t.accounts || []).length > 0;
    if (!configured) return 'none';
    return t.enabled ? 'on' : 'off';
  }
  if (id === 'whatsapp') {
    const w = state.whatsapp || {};
    if (!w.routeCount) return 'none';
    return w.enabled ? 'on' : 'off';
  }
  if (id === 'slack') {
    const s = state.slack || {};
    if (!s.botTokenRef || !s.appTokenRef) return 'none';
    return s.enabled ? 'on' : 'off';
  }
  if (id === 'discord') {
    const d = state.discord || {};
    if (!d.tokenRef) return 'none';
    return d.enabled ? 'on' : 'off';
  }
  if (id === 'gitlab') {
    const g = state.gitlab || {};
    if (!g.tokenRef) return 'none';
    return g.enabled ? 'on' : 'off';
  }
  if (id === 'github') {
    const webhooks = (state.webhooks || []).filter((w) => w.source === 'github');
    if (webhooks.length === 0) return 'none';
    return webhooks.some((w) => w.enabled) ? 'on' : 'off';
  }
  return 'none';
}

function renderChannelsMenu() {
  const menu = $('ch-menu');
  if (!menu) return;
  const activeId = menu.dataset.active || 'telegram';
  menu.innerHTML = CHANNEL_DEFS.map((c) => {
    const s = channelStatus(c.id);
    const dotCls = s === 'on' ? 'ch-dot ch-dot--on' : s === 'off' ? 'ch-dot ch-dot--off' : 'ch-dot';
    const dotTitle = s === 'on' ? 'enabled' : s === 'off' ? 'configured but off' : 'not set up';
    const isActive = c.id === activeId;
    return '<button data-ch="' + c.id + '" class="' + (isActive ? 'is-active' : '') + '">' +
      '<span class="ch-icon">' + c.icon + '</span>' +
      '<span class="ch-label">' + c.label + '</span>' +
      '<span class="' + dotCls + '" title="' + dotTitle + '"></span>' +
    '</button>';
  }).join('');
  for (const btn of menu.querySelectorAll('button')) {
    btn.addEventListener('click', () => selectChannel(btn.dataset.ch));
  }
  // Re-render the currently-selected pane's content.
  selectChannel(activeId, true);
}

function selectChannel(id, keep) {
  const menu = $('ch-menu');
  if (menu) menu.dataset.active = id;
  for (const btn of menu.querySelectorAll('button')) {
    btn.classList.toggle('is-active', btn.dataset.ch === id);
  }
  for (const v of document.querySelectorAll('.ch-view')) {
    v.hidden = v.id !== 'ch-' + id;
  }
  // Lazy-render the more static panes; telegram + slack re-render via their existing calls.
  if (id === 'discord') renderDiscordPane();
  else if (id === 'gitlab') renderGitLabPane();
  else if (id === 'github') renderGitHubPane();
  else if (id === 'whatsapp') renderWhatsAppPane();
}

function renderDiscordPane() {
  const d = state.discord || {};
  const stripRef = (ref) => (ref || '').replace(/^\\\$\\{|\\}$/g, '');
  const agentOptions = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '"' +
    (a.id === (d.agentBinding || '') ? ' selected' : '') + '>' +
    escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  const configured = !!d.tokenRef;
  const statusChip = configured
    ? (d.enabled ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--ax-accent)">enabled</span>' : '<span class="chip off">disabled</span>')
    : '<span class="chip off">not configured</span>';
  $('ch-discord').innerHTML =
    '<div class="row-card" style="margin-bottom:12px"><div class="info"><h3>Discord bot</h3>' +
      '<div class="meta">' + statusChip +
        (d.tokenRef ? ' token: <code style="font-family:var(--ax-mono)">' + escapeHtml(d.tokenRef) + '</code>' : '') +
        (d.agentBinding ? ' · agent: <b>' + escapeHtml(d.agentBinding) + '</b>' : '') +
      '</div></div>' +
      (configured ? '<label class="toggle-switch" style="margin:0"><input type="checkbox" id="dc-toggle"' + (d.enabled ? ' checked' : '') + ' /> <span>On</span></label>' : '') +
    '</div>' +
    '<div class="add-form"><h3>' + (configured ? 'Edit Discord' : 'Connect Discord') + '</h3>' +
      '<label>Bot token env-var<span class="hint">(from the Discord Developer Portal)</span></label>' +
      '<input id="dc-env" placeholder="DISCORD_BOT_TOKEN" value="' + escapeHtml(stripRef(d.tokenRef)) + '" />' +
      '<label>Default agent<span class="hint">(optional)</span></label>' +
      '<select id="dc-agent"><option value="">(none)</option>' + agentOptions + '</select>' +
      '<div class="actions"><button class="primary" onclick="configureDiscord()">' + (configured ? 'Save' : 'Connect') + '</button><div id="dc-msg" class="msg"></div></div>' +
      '<div class="hint-block">Bot needs <code>MESSAGE_CONTENT</code> intent enabled in the Developer Portal. Routing: @-mention in channels, always in DMs.</div>' +
    '</div>';
  const t = $('dc-toggle');
  if (t) t.addEventListener('change', async (e) => {
    try { await req('POST', '/api/admin/channels/discord/toggle', { enabled: e.target.checked }); refresh(); }
    catch (err) { showMsg($('global-msg'), 'err', err.message); e.target.checked = !e.target.checked; }
  });
}
async function configureDiscord() {
  const body = { tokenEnv: $('dc-env').value.trim(), agentBinding: $('dc-agent').value };
  try { const r = await req('POST', '/api/admin/channels/discord', body); showMsg($('dc-msg'), 'ok', (r.summary || 'Saved.') + (r.hint ? ' — ' + r.hint : '')); refresh(); }
  catch (e) { showMsg($('dc-msg'), 'err', e.message); }
}

function renderGitLabPane() {
  const g = state.gitlab || {};
  const stripRef = (ref) => (ref || '').replace(/^\\\$\\{|\\}$/g, '');
  const configured = !!g.tokenRef;
  const statusChip = configured
    ? (g.enabled ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--ax-accent)">enabled</span>' : '<span class="chip off">disabled</span>')
    : '<span class="chip off">not configured</span>';
  $('ch-gitlab').innerHTML =
    '<div class="row-card" style="margin-bottom:12px"><div class="info"><h3>GitLab</h3>' +
      '<div class="meta">' + statusChip +
        (g.host ? ' <code style="font-family:var(--ax-mono)">' + escapeHtml(g.host) + '</code>' : '') +
        (g.tokenRef ? ' · token: <code style="font-family:var(--ax-mono)">' + escapeHtml(g.tokenRef) + '</code>' : '') +
        ' · ' + g.routeCount + ' route(s) · ' + g.agentMappingCount + ' agent mapping(s)' +
      '</div></div>' +
      (configured ? '<label class="toggle-switch" style="margin:0"><input type="checkbox" id="gl-toggle"' + (g.enabled ? ' checked' : '') + ' /> <span>On</span></label>' : '') +
    '</div>' +
    '<div class="add-form"><h3>' + (configured ? 'Edit GitLab' : 'Connect GitLab') + '</h3>' +
      '<label>Host<span class="hint">(e.g. <code>https://gitlab.com</code> or your self-hosted URL)</span></label>' +
      '<input id="gl-host" placeholder="https://gitlab.com" value="' + escapeHtml(g.host || 'https://gitlab.com') + '" />' +
      '<label>Admin token env-var<span class="hint">(personal access token with <code>api</code> scope)</span></label>' +
      '<input id="gl-env" placeholder="GITLAB_TOKEN" value="' + escapeHtml(stripRef(g.tokenRef)) + '" />' +
      '<label>Webhook listen port<span class="hint">(incoming GitLab webhooks)</span></label>' +
      '<input id="gl-port" type="number" min="1" max="65535" value="' + (g.webhookPort || 18810) + '" />' +
      '<div class="actions"><button class="primary" onclick="configureGitLab()">' + (configured ? 'Save' : 'Connect') + '</button><div id="gl-msg" class="msg"></div></div>' +
      '<div class="hint-block">Per-project routes and per-agent tokens stay in the <b>Advanced</b> tab (raw JSON). Webhooks from GitLab are also registered in the <b>Webhooks</b> tab with source=<code>gitlab</code>.</div>' +
    '</div>';
  const t = $('gl-toggle');
  if (t) t.addEventListener('change', async (e) => {
    try { await req('POST', '/api/admin/channels/gitlab/toggle', { enabled: e.target.checked }); refresh(); }
    catch (err) { showMsg($('global-msg'), 'err', err.message); e.target.checked = !e.target.checked; }
  });
}
async function configureGitLab() {
  const body = {
    host: $('gl-host').value.trim(),
    tokenEnv: $('gl-env').value.trim(),
    webhookPort: parseInt($('gl-port').value, 10),
  };
  try { const r = await req('POST', '/api/admin/channels/gitlab', body); showMsg($('gl-msg'), 'ok', (r.summary || 'Saved.') + (r.hint ? ' — ' + r.hint : '')); refresh(); }
  catch (e) { showMsg($('gl-msg'), 'err', e.message); }
}

function renderGitHubPane() {
  const daemonUrl = (state.daemonUrl || '').replace(/\\/+$/, '');
  const ghHooks = (state.webhooks || []).filter((w) => w.source === 'github');
  const hookList = ghHooks.length === 0
    ? '<div class="empty">No GitHub webhooks registered yet.</div>'
    : ghHooks.map((w) => {
        const url = daemonUrl + '/webhook/' + encodeURIComponent(w.agentId) + '/github';
        const status = w.enabled
          ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--ax-accent)">enabled</span>'
          : '<span class="chip off">disabled</span>';
        return '<div class="row-card"><div class="info"><h3>' + escapeHtml(w.id) + '</h3>' +
          '<div class="meta">' + status + ' agent: <b>' + escapeHtml(w.agentId) + '</b> · ' +
            '<code style="font-family:var(--ax-mono);font-size:11px">' + escapeHtml(url) + '</code>' +
          '</div></div></div>';
      }).join('');
  $('ch-github').innerHTML =
    '<div class="hint-block" style="margin-bottom:14px">GitHub doesn&rsquo;t need a bot adapter — it speaks webhooks. Register one in the <b>Webhooks</b> tab with <code>source=github</code>, bind it to an agent, then paste the generated URL into the repo&rsquo;s <i>Settings → Webhooks</i>.</div>' +
    '<div class="list">' + hookList + '</div>' +
    '<div class="actions"><button class="primary" onclick="jumpToWebhooks()">Add a GitHub webhook →</button></div>';
}
function jumpToWebhooks() {
  for (const btn of document.querySelectorAll('nav.tabs button')) {
    if (btn.dataset.tab === 'webhooks') btn.click();
  }
  const src = document.getElementById('w-source');
  if (src) src.value = 'github';
}

function renderWhatsAppPane() {
  const w = state.whatsapp || {};
  const enabled = !!w.enabled;
  const statusChip = enabled
    ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--ax-accent)">enabled</span>'
    : '<span class="chip off">disabled</span>';
  $('ch-whatsapp').innerHTML =
    '<div class="row-card" style="margin-bottom:12px"><div class="info"><h3>WhatsApp</h3>' +
      '<div class="meta">' + statusChip +
        ' · session dir: <code style="font-family:var(--ax-mono)">' + escapeHtml(w.sessionDir) + '</code>' +
        ' · ' + w.routeCount + ' route(s)' +
      '</div></div></div>' +
    '<div id="wa-pairing" class="add-form"><h3>Pairing</h3>' +
      '<div id="wa-status" style="margin-bottom:10px;font-size:12px;color:var(--ax-muted)">checking…</div>' +
      '<div id="wa-qr-wrap" style="display:none;text-align:center;padding:14px;background:var(--ax-bg);border:1px solid var(--ax-border);border-radius:6px">' +
        '<img id="wa-qr" alt="WhatsApp QR" style="width:260px;height:260px;background:#fff;padding:8px;border-radius:4px" />' +
        '<div style="margin-top:10px;font-size:11px;color:var(--ax-muted);line-height:1.55">Open WhatsApp on your phone → <b>Settings</b> → <b>Linked devices</b> → <b>Link a device</b> and scan. The code refreshes every ~20s.</div>' +
      '</div>' +
      '<div id="wa-connected" style="display:none;padding:14px;background:color-mix(in oklch,var(--ax-accent) 10%,transparent);border:1px solid color-mix(in oklch,var(--ax-accent) 35%,transparent);border-radius:6px;color:var(--ax-accent);font-size:13px">✓ Paired — the daemon is signed in.</div>' +
      '<div id="wa-disabled" style="display:none;padding:14px;font-size:12px;color:var(--ax-muted);line-height:1.6">WhatsApp is currently disabled in <code>agentx.json</code>. Enable it there (or via the Advanced tab) and restart the daemon; the QR will appear once Baileys needs it.</div>' +
      '<div class="hint-block" style="margin-top:12px">Routes, phone numbers, and allow-lists live under <code>channels.whatsapp</code> in the <b>Advanced</b> tab. Requires <code>@whiskeysockets/baileys</code> installed in the daemon&rsquo;s dir.</div>' +
    '</div>';
  startWhatsAppPolling();
}

const _wa = { timer: null, lastQRSeen: '' };
function startWhatsAppPolling() {
  stopWhatsAppPolling();
  _wa.timer = setInterval(pollWhatsAppState, 3000);
  pollWhatsAppState();
}
function stopWhatsAppPolling() {
  if (_wa.timer) { clearInterval(_wa.timer); _wa.timer = null; }
}
async function pollWhatsAppState() {
  // Stop polling if the user switched away from the WhatsApp pane.
  const pane = $('ch-whatsapp');
  if (!pane || pane.hidden) { stopWhatsAppPolling(); return; }
  try {
    const s = await req('GET', '/api/admin/channels/whatsapp/state');
    const enabled = !!(state.whatsapp && state.whatsapp.enabled);
    const status = $('wa-status');
    const qrWrap = $('wa-qr-wrap');
    const connected = $('wa-connected');
    const disabled = $('wa-disabled');
    const qrImg = $('wa-qr');
    if (!enabled) {
      status.textContent = 'disabled in config';
      qrWrap.style.display = 'none'; connected.style.display = 'none'; disabled.style.display = 'block';
      return;
    }
    disabled.style.display = 'none';
    const connState = s.connection || 'init';
    const detail = s.detail ? ' — ' + s.detail : '';
    if (connState === 'open') {
      status.innerHTML = '<span style="color:var(--ax-accent)">● connected</span>';
      qrWrap.style.display = 'none'; connected.style.display = 'block';
    } else if (s.qr) {
      status.innerHTML = '<span style="color:var(--ax-warn)">● waiting for scan</span>' + (detail ? escapeHtml(detail) : '');
      connected.style.display = 'none'; qrWrap.style.display = 'block';
      // Bust cache when the QR actually changed.
      if (s.qrUpdatedAt !== _wa.lastQRSeen) {
        _wa.lastQRSeen = s.qrUpdatedAt;
        qrImg.src = '/api/admin/channels/whatsapp/qr.svg?t=' + encodeURIComponent(s.qrUpdatedAt || Date.now());
      }
    } else {
      status.textContent = connState + detail + ' — waiting for the daemon to emit a QR…';
      qrWrap.style.display = 'none'; connected.style.display = 'none';
    }
  } catch (e) {
    $('wa-status').innerHTML = '<span style="color:var(--ax-err)">' + escapeHtml(e.message) + '</span>';
  }
}

function renderSlackSection() {
  const s = state.slack || {};
  const agentOptions = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '"' +
    (a.id === (s.agentBinding || '') ? ' selected' : '') + '>' +
    escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  // Strip dollar-brace wrappers so the edit form shows just the env-var name.
  const stripRef = (ref) => (ref || '').replace(/^\\\$\\{|\\}$/g, '');
  const configured = s.botTokenRef && s.appTokenRef;
  const statusChip = configured
    ? (s.enabled
      ? '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--ax-accent)">enabled</span>'
      : '<span class="chip off">disabled</span>')
    : '<span class="chip off">not configured</span>';

  $('slack-section').innerHTML =
    '<h3 style="margin:0 0 8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--ax-muted)">Slack</h3>' +
    '<div class="row-card" style="margin-bottom:12px"><div class="info"><h3># slack workspace</h3>' +
      '<div class="meta">' + statusChip +
        (s.botTokenRef ? ' bot: <code style="font-family:var(--ax-mono)">' + escapeHtml(s.botTokenRef) + '</code>' : '') +
        (s.appTokenRef ? ' · app: <code style="font-family:var(--ax-mono)">' + escapeHtml(s.appTokenRef) + '</code>' : '') +
        (s.agentBinding ? ' · agent: <b>' + escapeHtml(s.agentBinding) + '</b>' : '') +
      '</div></div>' +
      (configured ? '<label class="toggle-switch" style="margin:0"><input type="checkbox" id="slack-toggle"' + (s.enabled ? ' checked' : '') + ' /> <span>On</span></label>' : '') +
    '</div>' +
    '<div class="add-form"><h3>' + (configured ? 'Edit Slack connection' : 'Connect Slack') + '</h3>' +
      '<div class="rowf">' +
        '<div><label>Bot token env-var<span class="hint">(<code>xoxb-…</code>)</span></label><input id="slack-bot-env" placeholder="SLACK_BOT_TOKEN" value="' + escapeHtml(stripRef(s.botTokenRef)) + '" /></div>' +
        '<div><label>App token env-var<span class="hint">(<code>xapp-…</code> — Socket Mode)</span></label><input id="slack-app-env" placeholder="SLACK_APP_TOKEN" value="' + escapeHtml(stripRef(s.appTokenRef)) + '" /></div>' +
      '</div>' +
      '<label>Default agent<span class="hint">(optional — used when a Slack message has no explicit @mention of another agent)</span></label>' +
      '<select id="slack-agent"><option value="">(none)</option>' + agentOptions + '</select>' +
      '<div class="actions"><button class="primary" onclick="configureSlack()">' + (configured ? 'Save changes' : 'Connect') + '</button>' +
        '<div id="slack-msg" class="msg"></div></div>' +
      '<div class="hint-block">Create the Slack app at <code>api.slack.com/apps</code>, enable Socket Mode, and generate an app-level token with <code>connections:write</code>. Bot needs scopes <code>chat:write</code>, <code>app_mentions:read</code>, <code>channels:history</code>, <code>im:history</code>, <code>users:read</code>, and event subscriptions for <code>app_mention</code> + <code>message.*</code>. Add <code>xoxb-…</code> and <code>xapp-…</code> to <code>.env</code>, then install <code>@slack/socket-mode</code> + <code>@slack/web-api</code>.</div>' +
    '</div>';
  const t = $('slack-toggle');
  if (t) t.addEventListener('change', async (e) => {
    try { await req('POST', '/api/admin/channels/slack/toggle', { enabled: e.target.checked }); refresh(); }
    catch (err) { showMsg($('global-msg'), 'err', err.message); e.target.checked = !e.target.checked; }
  });
}

async function configureSlack() {
  const body = {
    botTokenEnv: $('slack-bot-env').value.trim(),
    appTokenEnv: $('slack-app-env').value.trim(),
    agentBinding: $('slack-agent').value,
  };
  try {
    const r = await req('POST', '/api/admin/channels/slack', body);
    showMsg($('slack-msg'), 'ok', (r.summary || 'Saved.') + (r.hint ? ' — ' + r.hint : ''));
    refresh();
  } catch (e) { showMsg($('slack-msg'), 'err', e.message); }
}

function openTelegramEdit(acc) {
  const modal = $('tg-edit-modal');
  $('tg-edit-title').textContent = 'Edit Telegram · ' + acc.id;
  $('tg-edit-agent').innerHTML = state.agents.map((a) =>
    '<option value="' + escapeHtml(a.id) + '"' + (a.id === acc.agentBinding ? ' selected' : '') + '>' +
    escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  $('tg-edit-user').value = acc.botUsername || '';
  // Current token ref is a dollar-brace placeholder — strip the wrapper for the form.
  const ref = acc.botTokenRef || '';
  $('tg-edit-env').value = ref.replace(/^\\\$\\{|\\}$/g, '');
  $('tg-edit-id').value = acc.id;
  $('tg-edit-msg').className = 'msg';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeTelegramEdit() {
  const modal = $('tg-edit-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

async function saveTelegramEdit() {
  const id = $('tg-edit-id').value;
  const patch = {
    agentBinding: $('tg-edit-agent').value,
    botUsername: $('tg-edit-user').value.trim(),
    botTokenEnv: $('tg-edit-env').value.trim(),
  };
  try {
    await req('PATCH', '/api/admin/channels/telegram', { id, patch });
    showMsg($('tg-edit-msg'), 'ok', 'Saved.');
    setTimeout(() => { closeTelegramEdit(); refresh(); }, 500);
  } catch (e) { showMsg($('tg-edit-msg'), 'err', e.message); }
}

async function addTelegram() {
  const body = {
    id: $('tg-id').value.trim(),
    agentBinding: $('tg-agent').value,
    botUsername: $('tg-user').value.trim(),
    botTokenEnv: $('tg-env').value.trim(),
  };
  try {
    const r = await req('POST', '/api/admin/channels/telegram', body);
    showMsg($('tg-msg'), 'ok', (r.summary || 'Added.') + (r.hint ? ' — ' + r.hint : ''));
    refresh();
  } catch (e) { showMsg($('tg-msg'), 'err', e.message); }
}

async function deleteTelegram(id) {
  if (!confirm('Delete Telegram account "' + id + '"?')) return;
  try { await req('DELETE', '/api/admin/channels/telegram', { id }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

function renderCrons() {
  const list = $('cron-list');
  if (!state.crons.length) { list.innerHTML = '<div class="empty">No schedules yet.</div>'; return; }
  list.innerHTML = '';
  for (const c of state.crons) {
    const div = document.createElement('div');
    div.className = 'row-card';
    div.innerHTML =
      '<div class="info"><h3>' + escapeHtml(c.id) + '</h3>' +
        '<div class="meta"><span class="chip">' + escapeHtml(c.schedule) + '</span> agent: <b>' + escapeHtml(c.agent) + '</b> — ' + escapeHtml(c.prompt) + '</div>' +
      '</div>' +
      '<button class="danger" data-id="' + escapeHtml(c.id) + '">Delete</button>';
    div.querySelector('button.danger').addEventListener('click', () => deleteCron(c.id));
    list.appendChild(div);
  }
}

async function addCron() {
  const body = {
    id: $('c-id').value.trim(),
    schedule: $('c-schedule').value.trim(),
    agent: $('c-agent').value,
    prompt: $('c-prompt').value.trim(),
  };
  try {
    const r = await req('POST', '/api/admin/crons', body);
    showMsg($('c-msg'), 'ok', r.summary || 'Added.');
    $('c-id').value = ''; $('c-schedule').value = ''; $('c-prompt').value = '';
    refresh();
  } catch (e) { showMsg($('c-msg'), 'err', e.message); }
}

async function deleteCron(id) {
  if (!confirm('Delete schedule "' + id + '"?')) return;
  try { await req('DELETE', '/api/admin/crons', { id }); refresh(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

// Live cron preview — debounced so each keystroke doesn't hit the server.
let cronPreviewTimer = null;
function scheduleCronPreview() {
  if (cronPreviewTimer) clearTimeout(cronPreviewTimer);
  cronPreviewTimer = setTimeout(runCronPreview, 300);
}
async function runCronPreview() {
  const expr = $('c-schedule').value.trim();
  const box = $('c-preview');
  if (!expr) { box.textContent = ''; return; }
  try {
    const r = await req('POST', '/api/admin/crons/preview', { schedule: expr });
    const fires = r.next.map((iso) => new Date(iso).toLocaleString()).slice(0, 3);
    box.innerHTML =
      '<div style="color:var(--text)"><b>' + escapeHtml(r.human) + '</b></div>' +
      '<div style="margin-top:4px">Next runs (' + escapeHtml(r.timezone) + '): ' + fires.map(escapeHtml).join(' · ') + '</div>';
  } catch (e) {
    box.innerHTML = '<div style="color:var(--red)">' + escapeHtml(e.message) + '</div>';
  }
}
$('c-schedule').addEventListener('input', scheduleCronPreview);

// --- Files modal (identity + skills) ---
const filesModal = {
  el: $('files-modal'),
  agentId: null,
  agentName: null,
  currentTab: 'identity',  // 'identity' | 'skills'
  currentPath: null,       // path of file being edited
  originalContent: '',     // for revert
};

async function openFilesModal(agentId, agentName) {
  filesModal.agentId = agentId;
  filesModal.agentName = agentName;
  $('files-title').textContent = agentName + ' · Files';
  filesModal.el.classList.remove('hidden');
  filesModal.el.setAttribute('aria-hidden', 'false');
  switchFilesTab('identity');
}

function closeFilesModal() {
  filesModal.el.classList.add('hidden');
  filesModal.el.setAttribute('aria-hidden', 'true');
  filesModal.agentId = null;
  filesModal.currentPath = null;
  hideFileEditor();
}

function switchFilesTab(tab) {
  filesModal.currentTab = tab;
  filesModal.currentPath = null;
  $('files-tab-label').textContent = tab === 'skills' ? 'Skills' : 'Identity';
  $('files-tab-identity').style.background = tab === 'identity' ? 'rgba(99,102,241,0.15)' : 'transparent';
  $('files-tab-skills').style.background = tab === 'skills' ? 'rgba(99,102,241,0.15)' : 'transparent';
  $('files-add-skill').style.display = tab === 'skills' ? 'block' : 'none';
  hideFileEditor();
  loadFileList();
}

async function loadFileList() {
  const picker = $('files-picker');
  picker.innerHTML = '<div class="empty" style="padding:20px 10px;color:var(--muted)">loading…</div>';
  try {
    const r = await req('GET', '/api/admin/files?agent=' + encodeURIComponent(filesModal.agentId));
    filesModal.overview = r;
    renderFilesPicker(r);
  } catch (e) {
    picker.innerHTML = '<div class="empty" style="color:var(--red);padding:14px">' + escapeHtml(e.message) + '</div>';
  }
}

function renderFilesPicker(overview) {
  const picker = $('files-picker');
  if (filesModal.currentTab === 'identity') {
    const rows = overview.identity.map((f) => {
      const activeCls = filesModal.currentPath === f.path ? ' active' : '';
      const missingCls = f.exists ? '' : ' missing';
      const sizeLabel = f.exists ? formatBytes(f.size) : 'create';
      return '<div class="file' + activeCls + missingCls + '" data-path="' + escapeHtml(f.path) + '">' +
        '<span class="info">' + escapeHtml(f.title) + '</span>' +
        '<span class="size">' + sizeLabel + '</span>' +
      '</div>';
    }).join('');
    picker.innerHTML = '<div class="group">Identity files</div>' + (rows || '<div class="empty">No files.</div>');
  } else {
    if (overview.skills.length === 0) {
      picker.innerHTML = '<div class="group">Skills</div><div class="empty" style="padding:14px;color:var(--muted)">No skills yet.</div>';
    } else {
      const rows = overview.skills.map((s) => {
        const activeCls = filesModal.currentPath === s.path ? ' active' : '';
        return '<div class="file' + activeCls + '" data-path="' + escapeHtml(s.path) + '" data-slug="' + escapeHtml(s.slug) + '">' +
          '<span class="info">' + escapeHtml(s.title) + '<br><span class="size">' + escapeHtml(s.slug) + '</span></span>' +
          '<button class="del" data-rm-skill="' + escapeHtml(s.slug) + '" title="Delete skill">🗑</button>' +
        '</div>';
      }).join('');
      picker.innerHTML = '<div class="group">Skills</div>' + rows;
    }
  }
  for (const row of picker.querySelectorAll('.file')) {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-rm-skill]')) return;
      openFileInEditor(row.dataset.path);
    });
  }
  for (const btn of picker.querySelectorAll('[data-rm-skill]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSkill(btn.dataset.rmSkill);
    });
  }
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(/\\.0$/, '') + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

async function openFileInEditor(path) {
  filesModal.currentPath = path;
  renderFilesPicker(filesModal.overview);  // restyle active row
  try {
    const r = await req('GET', '/api/admin/files/read?agent=' + encodeURIComponent(filesModal.agentId) + '&path=' + encodeURIComponent(path));
    filesModal.originalContent = r.content;
    $('files-current-path').textContent = path;
    $('files-editor').value = r.content;
    $('files-editor-empty').style.display = 'none';
    $('files-editor-head').style.display = 'flex';
    $('files-editor-wrap').style.display = 'flex';
    $('files-save-msg').className = 'msg';
  } catch (e) { showMsg($('files-save-msg'), 'err', e.message); }
}

function hideFileEditor() {
  $('files-editor-empty').style.display = 'flex';
  $('files-editor-head').style.display = 'none';
  $('files-editor-wrap').style.display = 'none';
  $('files-save-msg').className = 'msg';
  $('files-editor').value = '';
}

async function saveCurrentFile() {
  if (!filesModal.currentPath) return;
  const content = $('files-editor').value;
  try {
    const r = await req('PUT', '/api/admin/files', {
      agent: filesModal.agentId,
      path: filesModal.currentPath,
      content,
    });
    filesModal.originalContent = content;
    showMsg($('files-save-msg'), 'ok', r.summary);
    loadFileList();
  } catch (e) { showMsg($('files-save-msg'), 'err', e.message); }
}

function revertCurrentFile() {
  $('files-editor').value = filesModal.originalContent;
  $('files-save-msg').className = 'msg';
}

async function addSkill() {
  const slug = $('skill-slug').value.trim();
  const title = $('skill-title').value.trim();
  const fileInput = $('skill-file');
  const file = fileInput && fileInput.files && fileInput.files[0];
  let content;
  if (file) {
    try { content = await readFileAsText(file); }
    catch (e) { showMsg($('skill-msg'), 'err', 'Could not read file: ' + e.message); return; }
    if (content.length > 200 * 1024) {
      showMsg($('skill-msg'), 'err', 'File too large (>200 KB). Edit in-place after creation instead.');
      return;
    }
  }
  try {
    const body = { agent: filesModal.agentId, slug, title };
    if (content != null) body.content = content;
    const r = await req('POST', '/api/admin/files/skill', body);
    showMsg($('skill-msg'), 'ok', r.summary);
    $('skill-slug').value = ''; $('skill-title').value = '';
    if (fileInput) fileInput.value = '';
    await loadFileList();
    openFileInEditor(r.path);
  } catch (e) { showMsg($('skill-msg'), 'err', e.message); }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsText(file);
  });
}

// Upload-into-editor: replaces the current file's buffer with the uploaded text.
// User still has to click Save for the write to land on disk, so accidents are reversible.
function wireFilesUpload() {
  const input = $('files-upload');
  if (!input) return;
  input.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      if (text.length > 200 * 1024) throw new Error('File too large (>200 KB).');
      $('files-editor').value = text;
      showMsg($('files-save-msg'), 'ok', 'Loaded into editor — click Save to persist.');
    } catch (err) {
      showMsg($('files-save-msg'), 'err', err.message);
    }
    e.target.value = '';
  });
}
wireFilesUpload();

async function removeSkill(slug) {
  if (!confirm('Delete skill "' + slug + '"? The skill folder and SKILL.md will be removed from disk.')) return;
  try {
    await req('DELETE', '/api/admin/files/skill', { agent: filesModal.agentId, slug });
    if (filesModal.currentPath && filesModal.currentPath.includes('/' + slug + '/')) hideFileEditor();
    loadFileList();
  } catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

$('files-close').addEventListener('click', closeFilesModal);
$('files-modal').querySelector('.td-backdrop').addEventListener('click', closeFilesModal);
$('files-tab-identity').addEventListener('click', () => switchFilesTab('identity'));
$('files-tab-skills').addEventListener('click', () => switchFilesTab('skills'));
$('files-save').addEventListener('click', saveCurrentFile);
$('files-revert').addEventListener('click', revertCurrentFile);
$('files-editor').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !filesModal.el.classList.contains('hidden')) closeFilesModal();
});

// --- Edit agent modal ---
const editModal = {
  el: $('edit-modal'),
  currentId: null,
};

function openAgentEdit(agent) {
  editModal.currentId = agent.id;
  $('edit-title').textContent = agent.name + ' · ' + agent.id;
  $('e-name').value = agent.name || '';
  $('e-tier').value = agent.tier || 'claude-code';
  $('e-model').value = agent.model || '';
  $('e-triggers').value = (agent.mentions || []).join(', ');
  $('e-personality').value = agent.systemPrompt || '';
  $('e-max-concurrent').value = agent.maxConcurrent || 1;
  $('e-max-exec').value = agent.maxExecutionMinutes || 20;
  $('e-perm').value = agent.permissionMode || 'default';
  $('e-access').checked = agent.access === 'public';
  $('e-msg').className = 'msg';
  editModal.el.classList.remove('hidden');
  editModal.el.setAttribute('aria-hidden', 'false');
}

function closeAgentEdit() {
  editModal.el.classList.add('hidden');
  editModal.el.setAttribute('aria-hidden', 'true');
  editModal.currentId = null;
}

async function saveAgentEdit() {
  if (!editModal.currentId) return;
  const id = editModal.currentId;
  const maxConcurrent = parseInt($('e-max-concurrent').value, 10);
  const maxExecutionMinutes = parseInt($('e-max-exec').value, 10);
  const patch = {
    name: $('e-name').value.trim(),
    tier: $('e-tier').value,
    model: $('e-model').value.trim(),
    triggerWords: $('e-triggers').value.trim(),
    systemPrompt: $('e-personality').value,
    maxConcurrent: Number.isFinite(maxConcurrent) ? maxConcurrent : undefined,
    maxExecutionMinutes: Number.isFinite(maxExecutionMinutes) ? maxExecutionMinutes : undefined,
    permissionMode: $('e-perm').value,
    access: $('e-access').checked ? 'public' : 'private',
  };
  try {
    await req('PATCH', '/api/admin/agents', { id, patch });
    showMsg($('e-msg'), 'ok', 'Saved. The change is live (hot-reloaded).');
    setTimeout(() => { closeAgentEdit(); refresh(); }, 600);
  } catch (e) { showMsg($('e-msg'), 'err', e.message); }
}

// Telegram edit wiring
$('tg-edit-close').addEventListener('click', closeTelegramEdit);
$('tg-edit-cancel').addEventListener('click', closeTelegramEdit);
$('tg-edit-save').addEventListener('click', saveTelegramEdit);
$('tg-edit-modal').querySelector('.td-backdrop').addEventListener('click', closeTelegramEdit);

$('edit-close').addEventListener('click', closeAgentEdit);
$('edit-cancel').addEventListener('click', closeAgentEdit);
$('edit-save').addEventListener('click', saveAgentEdit);
editModal.el.querySelector('.td-backdrop').addEventListener('click', closeAgentEdit);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !editModal.el.classList.contains('hidden')) closeAgentEdit();
});

// --- Test drive chat modal ---
const testDrive = {
  modal: $('td-modal'),
  body: $('td-body'),
  title: $('td-title'),
  input: $('td-input'),
  sendBtn: $('td-send'),
  hint: $('td-hint'),
  closeBtn: $('td-close'),
  agentId: null,
  chatId: null,  // stable per modal open so follow-ups share session context
  thinkingEl: null,
  busy: false,
};

function openTestDrive(agentId, agentName) {
  testDrive.agentId = agentId;
  testDrive.chatId = 'admin-' + Date.now();
  testDrive.title.textContent = agentName + ' · ' + agentId;
  testDrive.body.innerHTML = '<div class="td-empty">Send a message to sanity-check this agent before wiring it to a real channel.</div>';
  testDrive.hint.textContent = 'Session: ' + testDrive.chatId + ' · channel: test-drive';
  testDrive.input.value = '';
  testDrive.modal.classList.remove('hidden');
  testDrive.modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => testDrive.input.focus(), 50);
}

function closeTestDrive() {
  testDrive.modal.classList.add('hidden');
  testDrive.modal.setAttribute('aria-hidden', 'true');
  testDrive.agentId = null;
  testDrive.chatId = null;
}

function appendChat(kind, text) {
  const empty = testDrive.body.querySelector('.td-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'td-msg ' + kind;
  el.textContent = text;
  testDrive.body.appendChild(el);
  testDrive.body.scrollTop = testDrive.body.scrollHeight;
  return el;
}

async function sendTestDrive() {
  if (testDrive.busy) return;
  const msg = testDrive.input.value.trim();
  if (!msg || !testDrive.agentId) return;
  appendChat('user', msg);
  testDrive.input.value = '';
  testDrive.input.style.height = 'auto';
  testDrive.thinkingEl = appendChat('thinking', 'thinking…');
  testDrive.busy = true;
  testDrive.sendBtn.disabled = true;
  try {
    const r = await req('POST', '/api/admin/agents/test', {
      agent: testDrive.agentId,
      message: msg,
      chatId: testDrive.chatId,
    });
    testDrive.thinkingEl?.remove();
    testDrive.thinkingEl = null;
    const reply = r?.response?.content || r?.response?.error || '(empty reply)';
    appendChat(r?.response?.error ? 'err' : 'agent', reply);
  } catch (e) {
    testDrive.thinkingEl?.remove();
    testDrive.thinkingEl = null;
    appendChat('err', e.message);
  } finally {
    testDrive.busy = false;
    testDrive.sendBtn.disabled = false;
    testDrive.input.focus();
  }
}

testDrive.sendBtn.addEventListener('click', sendTestDrive);
testDrive.closeBtn.addEventListener('click', closeTestDrive);
testDrive.modal.querySelector('.td-backdrop').addEventListener('click', closeTestDrive);
testDrive.input.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendTestDrive(); }
});
testDrive.input.addEventListener('input', () => {
  // Autogrow the textarea up to 120px.
  testDrive.input.style.height = 'auto';
  testDrive.input.style.height = Math.min(testDrive.input.scrollHeight, 120) + 'px';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !testDrive.modal.classList.contains('hidden')) closeTestDrive();
});

// --- Tokens tab ---
const SCOPE_CHOICES = [
  { value: 'dashboard:read', label: 'Read dashboard + live view' },
  { value: 'dashboard:write', label: 'Write (admin + config) — full control' },
  { value: 'agent:*', label: 'Message any public agent' },
  { value: 'mesh:peer', label: 'Mesh peer auth (cross-node)' },
];

function renderScopeChoices() {
  const publicAgents = state.agents.filter((a) => a.access === 'public');
  const agentScopes = publicAgents.map((a) => ({ value: 'agent:' + a.id, label: 'Message agent: ' + a.name + ' (' + a.id + ')' }));
  const all = SCOPE_CHOICES.concat(agentScopes);
  const host = $('t-scopes');
  host.innerHTML = all.map((c) => {
    return '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text);font-weight:400;margin:0">' +
      '<input type="checkbox" value="' + escapeHtml(c.value) + '" style="width:auto" /> ' +
      '<code style="background:#0e1119;padding:1px 6px;border-radius:3px;font-family:ui-monospace,monospace;font-size:11px;color:var(--accent)">' + escapeHtml(c.value) + '</code>' +
      '<span style="color:var(--muted)">— ' + escapeHtml(c.label) + '</span>' +
    '</label>';
  }).join('');
}

async function loadTokens() {
  renderScopeChoices();
  try {
    const tokens = await req('GET', '/api/admin/tokens');
    const list = $('token-list');
    if (!tokens.length) { list.innerHTML = '<div class="empty">No tokens issued.</div>'; return; }
    list.innerHTML = '';
    for (const t of tokens) {
      const div = document.createElement('div');
      div.className = 'row-card';
      const status = t.revokedAt
        ? '<span class="chip" style="background:rgba(239,68,68,0.15);color:var(--red)">revoked</span>'
        : (t.expiresAt && Date.parse(t.expiresAt) < Date.now()
          ? '<span class="chip" style="background:rgba(245,158,11,0.15);color:var(--yellow)">expired</span>'
          : '<span class="chip" style="background:rgba(34,197,94,0.15);color:var(--green)">active</span>');
      const expiry = t.expiresAt ? ' · expires ' + new Date(t.expiresAt).toLocaleDateString() : ' · no expiry';
      const lastUsed = t.lastUsedAt ? ' · last used ' + new Date(t.lastUsedAt).toLocaleString() : ' · never used';
      div.innerHTML =
        '<div class="info"><h3>' + escapeHtml(t.name) + '</h3>' +
          '<div class="meta">' + status +
            '<b>' + escapeHtml(t.id) + '</b> · <code style="font-family:ui-monospace,monospace">' + escapeHtml(t.prefix) + '…</code> · scopes: ' + (t.scopes.map(escapeHtml).join(', ') || '—') + expiry + lastUsed +
          '</div>' +
        '</div>' +
        (t.revokedAt ? '' : '<button class="danger" data-id="' + escapeHtml(t.id) + '">Revoke</button>');
      const del = div.querySelector('button.danger');
      if (del) del.addEventListener('click', () => revokeToken(t.id));
      $('token-list').appendChild(div);
    }
  } catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

async function createToken() {
  const name = $('t-name').value.trim();
  const scopes = [...document.querySelectorAll('#t-scopes input:checked')].map((el) => el.value);
  const expires = $('t-expires').value.trim();
  try {
    const body = { name, scopes, expiresInDays: expires ? parseInt(expires, 10) : undefined };
    const r = await req('POST', '/api/admin/tokens', body);
    $('t-secret').textContent = r.token;
    $('t-reveal').style.display = 'block';
    showMsg($('t-msg'), 'ok', r.summary);
    $('t-name').value = ''; $('t-expires').value = '';
    document.querySelectorAll('#t-scopes input:checked').forEach((el) => { el.checked = false; });
    loadTokens();
  } catch (e) { showMsg($('t-msg'), 'err', e.message); }
}

async function revokeToken(id) {
  if (!confirm('Revoke this token? Any callers using it will immediately fail.')) return;
  try { await req('DELETE', '/api/admin/tokens', { id }); loadTokens(); }
  catch (e) { showMsg($('global-msg'), 'err', e.message); }
}

async function loadRaw() {
  try {
    const r = await fetch('/api/admin/config');
    const txt = await r.text();
    $('raw-editor').value = txt;
    showMsg($('r-msg'), 'ok', 'Loaded.');
  } catch (e) { showMsg($('r-msg'), 'err', e.message); }
}

async function saveRaw() {
  const raw = $('raw-editor').value;
  try {
    const r = await req('POST', '/api/admin/config/raw', { raw });
    showMsg($('r-msg'), 'ok', (r.summary || 'Saved.') + (r.backupPath ? ' (backup: ' + r.backupPath.split('/').pop() + ')' : ''));
    refresh();
  } catch (e) { showMsg($('r-msg'), 'err', e.message); }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tab switching
for (const btn of document.querySelectorAll('nav.tabs button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('section.tab').forEach((s) => s.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'advanced') loadRaw();
    if (btn.dataset.tab === 'tokens') loadTokens();
  });
}

refresh();

// --- Theme switcher wiring (bootstrap ran in <head>; we attach click handlers) ---
(function(){
  var sw = document.querySelectorAll('[data-theme-opt]');
  if (!sw.length) return;
  var current = document.documentElement.getAttribute('data-theme') || 'dark';
  sw.forEach(function(b){
    if (b.getAttribute('data-theme-opt') === current) b.classList.add('is-active');
    b.addEventListener('click', function(){
      var t = b.getAttribute('data-theme-opt');
      document.documentElement.setAttribute('data-theme', t);
      try { localStorage.setItem('ax-theme', t); } catch (e) {}
      sw.forEach(function(x){ x.classList.toggle('is-active', x === b); });
    });
  });
})();
</script>
</body>
</html>`
}
