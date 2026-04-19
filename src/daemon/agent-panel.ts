import type { IncomingMessage, ServerResponse } from "http"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import {
  listAgentFiles,
  readAgentFile,
  writeAgentFile,
  createAgentSkill,
  deleteAgentSkill,
  listSkillTree,
  readSkillFile,
  writeSkillFile,
  detectSkillDeps,
} from "./file-ops"
import { HandoverStore } from "@/channels/handover-store"
import { loadDaemonConfig } from "./config"
import { mutateAgentxConfig } from "./config-mutate"
import type { TopbarPeer } from "./topbar"
import { renderAgentPage } from "./ui/pages/agent"

// --- /admin/agents/<id> — one dedicated page per agent -------------------
//
// Layout:
//   Header  — name, tier, model, mentions, access
//   Overview   — editable systemPrompt + metadata form
//   Identity   — CLAUDE.md / SOUL.md / IDENTITY.md etc, EasyMDE editor
//   Skills     — directory tree per skill, file editor, install/deps actions
//   Channels   — read-only list of bindings
//   Activity   — recent tasks, today's KPI row
//
// "Install package" and "Install deps" DISPATCH through the daemon's /task
// endpoint using devops-agent (or node.defaultAgent) as the worker, with a
// confirm dialog in the UI. That way the user sees the action stream in
// the normal task view and it's logged like any other task.

// =======================================================================
// Route handlers
// =======================================================================

export function handleAgentPageGet(
  _req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  peers: TopbarPeer[] = [],
  localToken?: string,
): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(renderAgentPage({ agentId, peers, localToken }))
}

export async function handleAgentApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  try {
    const body = req.method === "GET" ? undefined : await readJsonBody(req)
    const url = new URL(req.url || "/", "http://localhost")
    const qs = Object.fromEntries(url.searchParams)
    const match = path.match(/^\/api\/admin\/agent\/([a-z0-9][a-z0-9_-]*)(?:\/(.+))?$/)
    if (!match) {
      sendJson(res, 404, { error: `unknown agent endpoint: ${path}` })
      return
    }
    const agentId = match[1]
    const sub = match[2] || ""
    const key = `${req.method} ${sub}`

    const dispatch: Record<string, () => unknown | Promise<unknown>> = {
      "GET ": () => getAgentState(agentId),
      "PATCH ": () => patchAgent(agentId, body),
      "GET identity": () => getIdentityFiles(agentId),
      "GET identity/file": () => getIdentityFile(agentId, String(qs.path || "")),
      "PUT identity/file": () => putIdentityFile(agentId, body),
      "GET skills": () => getSkills(agentId),
      "POST skills": () => postCreateSkill(agentId, body),
      "DELETE skills": () => deleteSkill(agentId, body),
      "GET skills/tree": () => getSkillTree(agentId, String(qs.slug || "")),
      "GET skills/file": () =>
        getSkillFile(agentId, String(qs.slug || ""), String(qs.path || "")),
      "PUT skills/file": () => putSkillFile(agentId, body),
      "GET skills/deps": () => getDepsHint(agentId, String(qs.slug || "")),
      "POST skills/install": () => dispatchInstallPackage(agentId, body, req),
      "POST skills/deps": () => dispatchInstallDeps(agentId, body, req),
      "GET channels": () => getChannelsForAgent(agentId),
      "GET activity": () => getRecentActivity(agentId, req),
      "GET handovers": () => listHandovers(agentId),
      "POST handovers": () => createHandover(agentId, body),
      "DELETE handovers": () => releaseHandover(body),
    }

    const handler = dispatch[key]
    if (!handler) {
      sendJson(res, 404, { error: `unknown agent sub-endpoint: ${key}` })
      return
    }
    const result = await handler()
    sendJson(res, 200, result)
  } catch (e: any) {
    sendJson(res, 400, { error: e?.message || "agent op failed" })
  }
}

// =======================================================================
// Helpers — reading & mutating agent config
// =======================================================================

function readConfigRaw(): any {
  const file = resolve(process.cwd(), "agentx.json")
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, "utf-8"))
}

function getAgentDef(agentId: string): any {
  const cfg = readConfigRaw()
  if (!cfg) throw new Error("agentx.json not found")
  const def = cfg.agents?.[agentId]
  if (!def) throw new Error(`Agent "${agentId}" not found`)
  return { def, cfg }
}

function getAgentState(agentId: string) {
  const { def, cfg } = getAgentDef(agentId)
  // A minimal workspace snapshot so the page header can render without a
  // second round trip.
  const overview = def.workspace ? listAgentFiles(def.workspace) : null
  return {
    id: agentId,
    name: def.name || agentId,
    tier: def.tier,
    model: def.model,
    workspace: def.workspace,
    systemPrompt: def.systemPrompt || "",
    mentions: def.mentions || [],
    access: def.access || "private",
    maxConcurrent: def.maxConcurrent ?? 1,
    maxExecutionMinutes: def.maxExecutionMinutes ?? 20,
    permissionMode: def.permissionMode || "default",
    overview,
    defaultWorker: cfg.node?.defaultAgent,
    draftAgent: cfg.dashboard?.draftAgent,
  }
}

function patchAgent(agentId: string, body: any) {
  const fields: Record<string, any> = {}
  for (const k of [
    "name", "tier", "model", "systemPrompt", "mentions",
    "access", "maxConcurrent", "maxExecutionMinutes", "permissionMode",
  ]) {
    if (body?.[k] !== undefined) fields[k] = body[k]
  }
  const { summary } = mutateAgentxConfig((cfg) => {
    if (!cfg.agents?.[agentId]) throw new Error(`Agent "${agentId}" not found`)
    cfg.agents[agentId] = { ...cfg.agents[agentId], ...fields }
    return `agent "${agentId}" updated (${Object.keys(fields).join(", ")})`
  })
  return { summary, agent: getAgentState(agentId) }
}

// =======================================================================
// Identity files
// =======================================================================

function getIdentityFiles(agentId: string) {
  const { def } = getAgentDef(agentId)
  return listAgentFiles(def.workspace)
}

function getIdentityFile(agentId: string, relPath: string) {
  if (!relPath) throw new Error("path query param required")
  const { def } = getAgentDef(agentId)
  return readAgentFile(def.workspace, relPath)
}

function putIdentityFile(agentId: string, body: any) {
  const relPath = String(body?.path || "")
  if (!relPath) throw new Error("path required")
  const { def } = getAgentDef(agentId)
  return writeAgentFile(def.workspace, relPath, String(body?.content ?? ""))
}

// =======================================================================
// Skills — list / tree / file I/O / create / delete
// =======================================================================

function getSkills(agentId: string) {
  const { def } = getAgentDef(agentId)
  const overview = listAgentFiles(def.workspace)
  return { skills: overview.skills, workspace: overview.workspace }
}

function postCreateSkill(agentId: string, body: any) {
  const slug = String(body?.slug || "").trim()
  if (!slug) throw new Error("slug required")
  const { def } = getAgentDef(agentId)
  return createAgentSkill(def.workspace, slug, {
    title: body?.title,
    content: body?.content,
  })
}

function deleteSkill(agentId: string, body: any) {
  const slug = String(body?.slug || "").trim()
  if (!slug) throw new Error("slug required")
  const { def } = getAgentDef(agentId)
  return deleteAgentSkill(def.workspace, slug)
}

function getSkillTree(agentId: string, slug: string) {
  if (!slug) throw new Error("slug query param required")
  const { def } = getAgentDef(agentId)
  const tree = listSkillTree(def.workspace, slug)
  const deps = detectSkillDeps(def.workspace, slug)
  return { slug, tree, deps }
}

function getSkillFile(agentId: string, slug: string, relPath: string) {
  if (!slug || !relPath) throw new Error("slug and path query params required")
  const { def } = getAgentDef(agentId)
  return readSkillFile(def.workspace, slug, relPath)
}

function putSkillFile(agentId: string, body: any) {
  const slug = String(body?.slug || "")
  const relPath = String(body?.path || "")
  if (!slug || !relPath) throw new Error("slug and path required")
  const { def } = getAgentDef(agentId)
  return writeSkillFile(def.workspace, slug, relPath, String(body?.content ?? ""))
}

function getDepsHint(agentId: string, slug: string) {
  if (!slug) throw new Error("slug query param required")
  const { def } = getAgentDef(agentId)
  return detectSkillDeps(def.workspace, slug)
}

// =======================================================================
// Dispatched actions — install package, install deps
// =======================================================================

async function dispatchInstallPackage(
  agentId: string,
  body: any,
  req: IncomingMessage,
): Promise<any> {
  const pkg = String(body?.package || "").trim()
  if (!pkg || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(pkg)) {
    throw new Error("package must be in 'owner/repo' or 'owner/repo/skill' form")
  }
  const worker = pickWorker(body?.worker)
  const { def } = getAgentDef(agentId)
  const message = [
    `Install the skills.sh package "${pkg}" into agent "${agentId}".`,
    `Workspace: ${def.workspace}`,
    `Run: cd ${def.workspace} && npx -y skills add ${pkg}`,
    `If that fails, fall back to: agentx skill install ${pkg}`,
    `Skills should land under ${def.workspace}/.claude/skills/. Report what was installed and any errors.`,
  ].join("\n")
  return dispatchTask(req, worker, message, `install-${pkg}:${Date.now()}`)
}

async function dispatchInstallDeps(
  agentId: string,
  body: any,
  req: IncomingMessage,
): Promise<any> {
  const slug = String(body?.slug || "").trim()
  if (!slug) throw new Error("slug required")
  const worker = pickWorker(body?.worker)
  const { def } = getAgentDef(agentId)
  const hint = detectSkillDeps(def.workspace, slug)
  if (!hint.manager) {
    throw new Error(
      `No dependency manifest detected in .claude/skills/${slug}. Expected one of: package.json, requirements.txt, Gemfile.`,
    )
  }
  const skillPath = resolve(def.workspace, ".claude", "skills", slug)
  const message = [
    `Install dependencies for skill "${slug}" in agent "${agentId}".`,
    `cd to: ${skillPath}`,
    `Detected manifest: ${hint.file}`,
    `Run: ${hint.command}`,
    `Stream the install output. On success, summarise the packages installed.`,
    `On failure, report the exit code and the last 20 lines of output.`,
  ].join("\n")
  return dispatchTask(req, worker, message, `deps-${agentId}-${slug}:${Date.now()}`)
}

function pickWorker(explicit?: string): string {
  if (explicit && typeof explicit === "string") return explicit
  const cfg = loadDaemonConfig()
  return (
    cfg.dashboard?.draftAgent ||
    cfg.node?.defaultAgent ||
    // Fall back to any agent that looks like devops — we need SOMEONE to run shell
    Object.keys(cfg.agents).find((id) => id.includes("devops")) ||
    Object.keys(cfg.agents)[0]
  )
}

async function dispatchTask(
  req: IncomingMessage,
  workerAgent: string,
  message: string,
  chatId: string,
): Promise<any> {
  const cfg = loadDaemonConfig()
  const daemonUrl = (cfg.dashboard.daemonUrl || "http://localhost:18800").replace(/\/+$/, "")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  // Forward the operator's bearer token to the daemon so the task is
  // attributed + auth'd correctly. The admin auth gate already verified us.
  const auth = req.headers.authorization
  if (auth) headers.Authorization = String(auth)
  else if (cfg.dashboard.token) headers.Authorization = `Bearer ${cfg.dashboard.token}`

  const r = await fetch(`${daemonUrl}/task`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: workerAgent,
      message,
      context: { channel: "admin", sender: "admin-ui", chatId },
    }),
  })
  const text = await r.text()
  let data: any
  try { data = JSON.parse(text) } catch { data = { content: text } }
  if (!r.ok) throw new Error(data?.error || `daemon /task HTTP ${r.status}`)
  return {
    worker: workerAgent,
    taskId: data?.taskId,
    content: data?.content,
    duration: data?.duration,
    error: data?.error,
  }
}

// =======================================================================
// Channels & activity — read-only, best-effort from config
// =======================================================================

function getChannelsForAgent(agentId: string) {
  const cfg = readConfigRaw()
  const out: Array<{ channel: string; account?: string; detail: string }> = []
  const tg = cfg?.channels?.telegram?.accounts || {}
  for (const [acct, def] of Object.entries<any>(tg)) {
    if (def?.agentBinding === agentId) {
      out.push({ channel: "telegram", account: acct, detail: def?.botUsername || acct })
    }
  }
  if (cfg?.channels?.slack?.agentBinding === agentId) {
    out.push({ channel: "slack", detail: "bound" })
  }
  if (cfg?.channels?.discord?.agentBinding === agentId) {
    out.push({ channel: "discord", detail: "bound" })
  }
  const gitlab = cfg?.channels?.gitlab?.agentMappings || []
  for (const m of gitlab) {
    if (m?.agentId === agentId) {
      out.push({
        channel: "gitlab",
        detail: (m?.gitlabUsernames || []).join(", ") || "mapped",
      })
    }
  }
  return { bindings: out }
}

async function getRecentActivity(agentId: string, _req: IncomingMessage): Promise<any> {
  // Pull from the daemon's /agents snapshot so we don't duplicate task
  // history logic. Keep it best-effort; a failing daemon shouldn't 500 the UI.
  try {
    const cfg = loadDaemonConfig()
    const daemonUrl = (cfg.dashboard.daemonUrl || "http://localhost:18800").replace(/\/+$/, "")
    const r = await fetch(`${daemonUrl}/agents`)
    if (!r.ok) throw new Error(`daemon HTTP ${r.status}`)
    const list: any[] = await r.json()
    const agent = list.find((a) => a.id === agentId)
    return {
      activeTasks: agent?.activeTasks ?? 0,
      totalTasks: agent?.totalTasks ?? 0,
      errors: agent?.errors ?? 0,
      lastActive: agent?.lastActive ?? null,
      runningTasks: agent?.runningTasks ?? [],
      lastSummary: agent?.lastSummary ?? null,
    }
  } catch (e: any) {
    return { error: e?.message, activeTasks: 0, totalTasks: 0, errors: 0, runningTasks: [] }
  }
}

// =======================================================================
// Handovers
// =======================================================================

function handoverStore(): HandoverStore {
  return new HandoverStore()
}

/** List active handovers for this agent, split by direction. */
function listHandovers(agentId: string) {
  const store = handoverStore()
  const { incoming, outgoing } = store.listByAgent(agentId)
  return { incoming, outgoing }
}

/** Create or replace a handover. Body:
 *  { channel, chatId, accountId?, toAgent, summary?, expiresAt?, fromAgent? }
 *  When `fromAgent` is omitted we default to the agent id in the URL — the
 *  common case is "I'm on agent X's page and handing this chat off from it
 *  to agent Y". */
function createHandover(pageAgentId: string, body: any) {
  const channel = String(body?.channel || "").trim()
  const chatId = String(body?.chatId || "").trim()
  const toAgent = String(body?.toAgent || "").trim()
  if (!channel || !chatId || !toAgent) {
    throw new Error("channel, chatId, toAgent required")
  }
  const fromAgent = String(body?.fromAgent || pageAgentId || "").trim() || pageAgentId
  const accountId = body?.accountId ? String(body.accountId) : undefined
  const summary = body?.summary ? String(body.summary) : undefined
  const expiresAt = body?.expiresAt ? String(body.expiresAt) : undefined
  const rec = handoverStore().set({
    channel, chatId, accountId, fromAgent, toAgent, summary, expiresAt,
    createdBy: "admin-ui",
  })
  return { summary: `Handed off ${channel}:${chatId} from ${fromAgent} to ${toAgent}`, record: rec }
}

function releaseHandover(body: any) {
  const channel = String(body?.channel || "").trim()
  const chatId = String(body?.chatId || "").trim()
  if (!channel || !chatId) throw new Error("channel and chatId required")
  const accountId = body?.accountId ? String(body.accountId) : undefined
  const removed = handoverStore().remove(channel, chatId, accountId)
  return { summary: removed ? "Released" : "No active handover for that chat" }
}

// =======================================================================
// Plumbing
// =======================================================================

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((ok, err) => {
    let raw = ""
    req.on("data", (c) => { raw += c })
    req.on("end", () => {
      try { ok(raw ? JSON.parse(raw) : {}) } catch (e) { err(e) }
    })
    req.on("error", err)
  })
}

// =======================================================================
// HTML
// =======================================================================


