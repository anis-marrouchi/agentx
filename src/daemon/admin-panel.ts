import { existsSync, readFileSync, writeFileSync, rmSync } from "fs"
import { resolve } from "path"
import type { IncomingMessage, ServerResponse } from "http"
import { mutateAgentxConfig } from "./config-mutate"
import { TokenStore } from "./token-store"
import { loadDaemonConfig } from "./config"

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
      "POST /api/admin/crons/preview": () => previewCron(body),
      "POST /api/admin/webhooks": () => addWebhook(body),
      "PATCH /api/admin/webhooks": () => editWebhook(body),
      "DELETE /api/admin/webhooks": () => deleteWebhook(body),
      "POST /api/admin/mesh/peers": () => addMeshPeer(body),
      "DELETE /api/admin/mesh/peers": () => deleteMeshPeer(body),
      "POST /api/admin/mesh/toggle": () => toggleMesh(body),
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
  return { exists: true, agents, telegram, crons, webhooks, mesh, daemonUrl, nodeName: cfg.node?.name }
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentX — Settings</title>
<style>
:root{--bg:#0b0d14;--card:#151823;--border:#2a2d3a;--text:#e6e8ef;--muted:#8b8fa3;--accent:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:14px 22px;border-bottom:1px solid var(--border);background:#10131c;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:10}
header .brand{font-weight:600;color:var(--accent);font-size:15px}
header .sub{color:var(--muted);font-weight:500}
.spacer{flex:1}
a.link{color:var(--muted);text-decoration:none;font-size:13px;padding:4px 10px;border:1px solid var(--border);border-radius:6px}
a.link:hover{color:var(--accent);border-color:var(--accent)}
nav.tabs{display:flex;gap:4px;padding:0 22px;border-bottom:1px solid var(--border);background:#10131c}
nav.tabs button{background:transparent;border:none;color:var(--muted);padding:12px 18px;font:13px/1.4 inherit;cursor:pointer;border-bottom:2px solid transparent}
nav.tabs button.active{color:var(--text);border-bottom-color:var(--accent)}
nav.tabs button:hover{color:var(--text)}
main{max-width:880px;margin:0 auto;padding:24px 22px 60px}
section.tab{display:none}
section.tab.active{display:block}
h2{font-size:16px;margin:0 0 6px}
.lead{color:var(--muted);margin:0 0 20px;font-size:13px}
.list{display:flex;flex-direction:column;gap:8px;margin-bottom:26px}
.row-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:14px}
.row-card .info{flex:1;min-width:0}
.row-card .info h3{margin:0 0 2px;font-size:13px;font-weight:600}
.row-card .info .meta{font-size:11px;color:var(--muted);font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-card .info .meta b{color:var(--text);font-weight:500}
.row-card button.danger{background:transparent;color:var(--red);border:1px solid rgba(239,68,68,0.3);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer}
.row-card button.danger:hover{background:rgba(239,68,68,0.1)}
.add-form{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-top:8px}
.add-form h3{margin:0 0 12px;font-size:13px;font-weight:600}
label{display:block;margin:8px 0 3px;font-size:12px;color:var(--muted)}
label .hint{font-weight:400;font-size:11px;margin-left:6px}
input,textarea,select{width:100%;background:#0e1119;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font:13px/1.4 inherit}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent)}
textarea{resize:vertical;min-height:60px;font-family:inherit}
textarea.raw{min-height:480px;font-family:ui-monospace,monospace;font-size:12px}
.rowf{display:flex;gap:10px}
.rowf > *{flex:1}
.actions{display:flex;gap:8px;margin-top:14px}
button.primary{background:var(--accent);color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer}
button.primary:hover{filter:brightness(1.1)}
button.primary:disabled{opacity:0.5;cursor:not-allowed}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:7px 14px;cursor:pointer;font-size:13px}
.msg{margin:10px 0;padding:10px 14px;border-radius:6px;font-size:13px;display:none}
.msg.ok{display:block;background:rgba(34,197,94,0.12);color:var(--green);border:1px solid rgba(34,197,94,0.3)}
.msg.err{display:block;background:rgba(239,68,68,0.12);color:var(--red);border:1px solid rgba(239,68,68,0.3)}
.msg.warn{display:block;background:rgba(245,158,11,0.12);color:var(--yellow);border:1px solid rgba(245,158,11,0.3)}
.empty{color:var(--muted);font-style:italic;padding:12px 0}
.toggle-switch{display:flex;align-items:center;gap:10px;margin-bottom:14px;font-size:13px}
.toggle-switch input{width:auto}
.chip{display:inline-block;font-size:10px;padding:2px 7px;border-radius:3px;background:rgba(99,102,241,0.15);color:var(--accent);font-family:ui-monospace,monospace;margin-right:4px}
.chip.off{background:rgba(107,114,128,0.15);color:var(--muted)}
.hint-block{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.55}
.hint-block code{background:#0e1119;padding:1px 6px;border-radius:3px;color:var(--text);font-family:ui-monospace,monospace;font-size:11px}
.section-block{margin-bottom:28px}

/* --- Test drive chat modal --- */
.td-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center}
.td-modal.hidden{display:none}
.td-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.6)}
.td-card{position:relative;width:min(640px,94vw);height:min(720px,90vh);background:var(--card);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,0.5);overflow:hidden}
.td-card > header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);background:#10131c}
.td-card > header h3{margin:0;font-size:14px;font-weight:600;flex:1}
.td-card .chip-small{font-size:10px;padding:2px 7px;border-radius:3px;background:rgba(99,102,241,0.14);color:var(--accent);letter-spacing:0.3px}
.td-close{background:transparent;border:none;color:var(--muted);font-size:20px;cursor:pointer;padding:0 6px;line-height:1}
.td-close:hover{color:var(--text)}
.td-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:#0a0c12}
.td-msg{max-width:82%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.5;word-wrap:break-word;white-space:pre-wrap}
.td-msg.user{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:2px}
.td-msg.agent{align-self:flex-start;background:#1a1d29;color:var(--text);border:1px solid var(--border);border-bottom-left-radius:2px}
.td-msg.err{align-self:flex-start;background:rgba(239,68,68,0.12);color:var(--red);border:1px solid rgba(239,68,68,0.3);border-bottom-left-radius:2px}
.td-msg.thinking{align-self:flex-start;color:var(--muted);font-style:italic;background:transparent;padding:4px 8px}
.td-empty{color:var(--muted);text-align:center;padding:40px 12px;font-style:italic;font-size:13px}
.td-footer{border-top:1px solid var(--border);padding:10px 12px;display:flex;gap:8px;align-items:flex-end;background:#10131c}
.td-footer textarea{flex:1;background:#0e1119;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font:13px/1.4 inherit;min-height:40px;max-height:120px;resize:none}
.td-footer textarea:focus{outline:none;border-color:var(--accent)}
.td-footer button{background:var(--accent);color:#fff;border:none;border-radius:6px;padding:8px 16px;font-weight:600;font-size:13px;cursor:pointer}
.td-footer button:disabled{opacity:0.5;cursor:not-allowed}
.td-hint{padding:6px 16px;font-size:10px;color:var(--muted);border-top:1px solid var(--border);background:#10131c;font-family:ui-monospace,monospace}
</style>
</head>
<body>
<header>
  <div class="brand">AgentX <span class="sub">· Settings</span></div>
  <div class="spacer"></div>
  <a href="/glossary" class="link">? Glossary</a>
  <a href="/live" class="link">← Dashboard</a>
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
    <p class="lead">Connect messaging platforms that agents respond on. Today: Telegram. More channels are available via the CLI (<code>agentx channel add</code>).</p>
    <div id="tg-section" class="section-block"></div>
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
  const t = state.telegram || { enabled: false, accounts: [] };
  const agentOptions = state.agents.map((a) => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + ' (' + escapeHtml(a.id) + ')</option>').join('');
  const accountRows = t.accounts.length === 0
    ? '<div class="empty">No Telegram accounts yet.</div>'
    : t.accounts.map((acc) =>
      '<div class="row-card"><div class="info"><h3>' + escapeHtml(acc.id) + '</h3>' +
      '<div class="meta">' +
        '<span class="chip ' + (t.enabled ? '' : 'off') + '">' + (t.enabled ? 'enabled' : 'disabled') + '</span>' +
        'bot: <b>' + escapeHtml(acc.botUsername || '—') + '</b> · agent: <b>' + escapeHtml(acc.agentBinding || '—') + '</b> · token ref: <b>' + escapeHtml(acc.botTokenRef || '—') + '</b>' +
      '</div></div><button class="danger" data-id="' + escapeHtml(acc.id) + '">Delete</button></div>').join('');
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
</script>
</body>
</html>`
}
