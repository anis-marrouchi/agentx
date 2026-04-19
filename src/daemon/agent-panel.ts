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
import {
  renderTopbar,
  TOPBAR_HEAD,
  TOPBAR_CSS,
  TOPBAR_SCRIPT,
  type TopbarPeer,
} from "./topbar"

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
  res.end(renderAgentHtml(agentId, peers, localToken))
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

function renderAgentHtml(agentId: string, peers: TopbarPeer[], localToken?: string): string {
  const topbar = renderTopbar({
    activeTab: "admin",
    subtitle: `Agent · ${agentId}`,
    peers,
  })
  const tokenScript = localToken
    ? `<script>window.AX_LOCAL_TOKEN = ${JSON.stringify(localToken)};</script>`
    : ""
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <title>AgentX · ${escapeHtml(agentId)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${TOPBAR_HEAD}
  <link rel="stylesheet" href="https://unpkg.com/easymde/dist/easymde.min.css">
  <style>
    :root{
      --ax-bg:#0a0b0f; --ax-bg-elev:#101218; --ax-surface:#151823;
      --ax-text:#e5e7eb; --ax-text-2:#b1b4c0; --ax-muted:#7a7d8a;
      --ax-border:#1d212d; --ax-border-2:#262a38; --ax-accent:#7aa2f7;
      --ax-green:#4ade80; --ax-red:#f87171; --ax-yellow:#fbbf24;
      --ax-mono:'IBM Plex Mono',ui-monospace,monospace;
    }
    :root[data-theme="light"]{
      --ax-bg:#f8fafc;--ax-bg-elev:#ffffff;--ax-surface:#ffffff;
      --ax-text:#111827;--ax-text-2:#374151;--ax-muted:#6b7280;
      --ax-border:#e5e7eb;--ax-border-2:#d1d5db;--ax-accent:#2563eb;
    }
    *{box-sizing:border-box}
    body{margin:0;background:var(--ax-bg);color:var(--ax-text);
      font-family:'IBM Plex Sans',system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5}
    ${TOPBAR_CSS}
    main{max-width:1280px;margin:0 auto;padding:18px 20px 60px}
    .msg{font-size:12px;padding:8px 12px;border-radius:4px;margin-bottom:12px;display:none}
    .msg.ok{background:rgba(74,222,128,0.12);color:var(--ax-green);display:block}
    .msg.err{background:rgba(248,113,113,0.12);color:var(--ax-red);display:block}
    .back-link{display:inline-flex;align-items:center;gap:6px;color:var(--ax-muted);
      text-decoration:none;font-size:12px;margin-bottom:12px}
    .back-link:hover{color:var(--ax-accent)}
    .card{background:var(--ax-bg-elev);border:1px solid var(--ax-border);
      border-radius:8px;padding:18px;margin-bottom:16px}
    .header-card{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
    .header-card h1{margin:0 0 6px;font-size:20px;font-weight:600;letter-spacing:-0.02em}
    .header-card .sub{color:var(--ax-muted);font-size:12px;font-family:var(--ax-mono)}
    .chips{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
    .chip{padding:2px 10px;border-radius:3px;font-size:11px;background:var(--ax-surface);
      color:var(--ax-text-2);border:1px solid var(--ax-border);font-family:var(--ax-mono)}
    .chip.accent{background:rgba(122,162,247,0.12);color:var(--ax-accent);border-color:transparent}
    nav.tabs{display:flex;gap:2px;margin-bottom:16px;border-bottom:1px solid var(--ax-border);
      padding:0 4px}
    nav.tabs button{background:transparent;border:none;color:var(--ax-muted);padding:10px 14px;
      font:inherit;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;
      letter-spacing:-0.005em;white-space:nowrap}
    nav.tabs button:hover{color:var(--ax-text)}
    nav.tabs button.active{color:var(--ax-text);border-bottom-color:var(--ax-accent)}
    section.tab{display:none}
    section.tab.active{display:block}
    button,.btn{font:inherit;font-size:12px;padding:7px 14px;border-radius:4px;
      border:1px solid var(--ax-border-2);background:var(--ax-surface);
      color:var(--ax-text);cursor:pointer}
    button:hover{border-color:var(--ax-accent);color:var(--ax-accent)}
    button.primary{background:var(--ax-accent);color:#0a0b0f;border-color:var(--ax-accent);font-weight:600}
    button.primary:hover{filter:brightness(1.08);color:#0a0b0f}
    button.danger{color:var(--ax-red);border-color:var(--ax-red)}
    button.danger:hover{background:var(--ax-red);color:#fff}
    button[disabled]{opacity:0.5;cursor:not-allowed}
    input,select,textarea{font:inherit;font-size:12px;padding:7px 10px;
      background:var(--ax-surface);color:var(--ax-text);
      border:1px solid var(--ax-border);border-radius:4px;width:100%;
      font-family:var(--ax-mono)}
    label{display:block;font-size:11px;color:var(--ax-muted);margin-bottom:4px;
      text-transform:uppercase;letter-spacing:0.05em;font-weight:600}
    .field{margin-bottom:12px}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .row > .field{flex:1 1 200px;min-width:0}
    .empty{color:var(--ax-muted);font-style:italic;padding:14px;text-align:center}
    .kv{display:flex;gap:8px;font-size:12px;color:var(--ax-text-2);margin:4px 0}
    .kv b{color:var(--ax-text);font-weight:500;min-width:80px}
    /* Skills browser */
    .skills-grid{display:grid;gap:14px;grid-template-columns:260px 260px 1fr;min-height:520px}
    @media(max-width:1000px){.skills-grid{grid-template-columns:1fr}}
    .skill-pane{background:var(--ax-surface);border:1px solid var(--ax-border);
      border-radius:6px;padding:10px;overflow:auto;max-height:620px}
    .skill-pane h3{font-size:11px;margin:0 0 10px;text-transform:uppercase;
      letter-spacing:0.06em;color:var(--ax-muted)}
    .skill-row{padding:6px 8px;border-radius:4px;cursor:pointer;display:flex;
      justify-content:space-between;align-items:center;font-size:12px;gap:6px}
    .skill-row:hover{background:var(--ax-bg-elev)}
    .skill-row.active{background:rgba(122,162,247,0.14);color:var(--ax-accent)}
    .skill-row .slug{font-family:var(--ax-mono);color:var(--ax-muted);font-size:11px}
    .tree-entry{display:flex;justify-content:space-between;padding:4px 6px;border-radius:3px;
      cursor:pointer;font-family:var(--ax-mono);font-size:11px;color:var(--ax-text-2)}
    .tree-entry:hover{background:var(--ax-bg-elev);color:var(--ax-text)}
    .tree-entry.active{background:rgba(122,162,247,0.14);color:var(--ax-accent)}
    .tree-entry.dir{color:var(--ax-muted);font-weight:500}
    .tree-entry.readonly{opacity:0.55;cursor:default}
    .editor-wrap{display:flex;flex-direction:column;gap:8px}
    .editor-wrap .toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .editor-wrap .path{font-family:var(--ax-mono);font-size:11px;color:var(--ax-muted);flex:1}
    /* EasyMDE theme tweaks for dark mode */
    .EasyMDEContainer .editor-toolbar{border-color:var(--ax-border);background:var(--ax-surface)}
    .EasyMDEContainer .editor-toolbar button{color:var(--ax-text-2)}
    .EasyMDEContainer .editor-toolbar button:hover,
    .EasyMDEContainer .editor-toolbar button.active{background:var(--ax-bg-elev);color:var(--ax-accent)}
    .EasyMDEContainer .CodeMirror{border-color:var(--ax-border);background:var(--ax-bg);
      color:var(--ax-text)}
    .EasyMDEContainer .CodeMirror-cursor{border-left-color:var(--ax-accent)}
    .EasyMDEContainer .editor-statusbar{color:var(--ax-muted)}
    .plain-editor{width:100%;min-height:420px;font-family:var(--ax-mono);font-size:12px;
      line-height:1.5;resize:vertical}
    /* Confirm modal */
    .modal{position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;
      align-items:center;justify-content:center;z-index:100}
    .modal[aria-hidden="true"]{display:none}
    .modal-card{background:var(--ax-bg-elev);border:1px solid var(--ax-border);
      border-radius:8px;padding:20px;max-width:560px;width:94vw}
    .modal-card h3{margin:0 0 10px;font-size:15px}
    .modal-card .detail{color:var(--ax-muted);font-size:12px;margin-bottom:14px;
      font-family:var(--ax-mono);background:var(--ax-surface);padding:10px;
      border-radius:4px;white-space:pre-wrap;word-break:break-word}
    .modal-card .row{justify-content:flex-end}
    .task-output{font-family:var(--ax-mono);font-size:11px;background:var(--ax-bg);
      border:1px solid var(--ax-border);border-radius:4px;padding:10px;
      max-height:300px;overflow:auto;white-space:pre-wrap;display:none;margin-top:10px}
  </style>
</head>
<body>
${topbar}
<main>
  <a class="back-link" href="/admin">← Back to Settings</a>
  <div id="msg" class="msg"></div>

  <div class="card header-card">
    <div style="flex:1">
      <h1 id="a-name">${escapeHtml(agentId)}</h1>
      <div class="sub" id="a-id">${escapeHtml(agentId)}</div>
      <div class="chips" id="a-chips"></div>
    </div>
    <div style="display:flex;gap:8px">
      <button id="btn-test-drive">Test drive</button>
      <button id="btn-save-meta" class="primary">Save</button>
    </div>
  </div>

  <nav class="tabs">
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="identity">Identity</button>
    <button data-tab="skills">Skills</button>
    <button data-tab="channels">Channels</button>
    <button data-tab="handovers">Handovers</button>
    <button data-tab="activity">Activity</button>
  </nav>

  <!-- Overview -->
  <section class="tab active" id="tab-overview">
    <div class="card">
      <label>System prompt</label>
      <textarea id="sp-editor" placeholder="# Who the agent is, what it does, how it communicates"></textarea>
    </div>
    <div class="card">
      <div class="row">
        <div class="field"><label>Name</label><input id="f-name" /></div>
        <div class="field"><label>Tier</label>
          <select id="f-tier">
            <option value="claude-code">claude-code</option>
            <option value="sdk">sdk</option>
            <option value="orchestrator">orchestrator</option>
          </select>
        </div>
        <div class="field"><label>Model</label><input id="f-model" /></div>
      </div>
      <div class="row">
        <div class="field"><label>Access</label>
          <select id="f-access">
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
        </div>
        <div class="field"><label>Max concurrent</label><input id="f-maxc" type="number" min="1" /></div>
        <div class="field"><label>Max execution (min)</label><input id="f-maxt" type="number" min="1" /></div>
        <div class="field"><label>Permission mode</label>
          <select id="f-pmode">
            <option value="default">default</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="plan">plan</option>
            <option value="bypassPermissions">bypassPermissions</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>Mentions (comma-separated)</label>
        <input id="f-mentions" placeholder="@noqta_foo_bot, foo" />
      </div>
    </div>
  </section>

  <!-- Identity -->
  <section class="tab" id="tab-identity">
    <div class="card">
      <div class="editor-wrap">
        <div class="toolbar">
          <label style="margin:0">File</label>
          <select id="id-select" style="width:260px"></select>
          <span class="path" id="id-path"></span>
          <button id="btn-save-id" class="primary">Save file</button>
        </div>
        <textarea id="id-editor"></textarea>
      </div>
    </div>
  </section>

  <!-- Skills -->
  <section class="tab" id="tab-skills">
    <div class="card">
      <div class="row" style="align-items:center">
        <div style="flex:1"></div>
        <input id="pkg-input" placeholder="owner/repo (or owner/repo/skill)" style="flex:0 0 320px" />
        <button id="btn-install-pkg">Install package…</button>
        <button id="btn-new-skill">+ New skill</button>
      </div>
      <div class="task-output" id="dispatch-output"></div>
    </div>
    <div class="skills-grid">
      <div class="skill-pane">
        <h3>Skills</h3>
        <div id="skills-list"></div>
      </div>
      <div class="skill-pane">
        <h3>Tree <span style="float:right"><button id="btn-install-deps" style="font-size:10px;padding:3px 8px" disabled>Install deps…</button> <button id="btn-delete-skill" class="danger" style="font-size:10px;padding:3px 8px" disabled>Delete</button></span></h3>
        <div id="skill-tree"></div>
      </div>
      <div class="skill-pane" style="padding:14px">
        <div class="editor-wrap" id="sk-editor-wrap" style="display:none">
          <div class="toolbar">
            <span class="path" id="sk-path">—</span>
            <button id="btn-save-sk" class="primary">Save file</button>
          </div>
          <textarea id="sk-editor"></textarea>
        </div>
        <div class="empty" id="sk-editor-empty">Select a file in the tree to edit.</div>
      </div>
    </div>
  </section>

  <!-- Channels -->
  <section class="tab" id="tab-channels">
    <div class="card"><div id="channels-list" class="empty">loading…</div></div>
  </section>

  <!-- Handovers -->
  <section class="tab" id="tab-handovers">
    <div class="card">
      <h2 style="margin:0 0 4px;font-size:14px">Hand this agent's chat to someone else</h2>
      <p class="muted" style="margin:0 0 12px">Routes every subsequent message from (channel, chatId) to the target agent. A one-shot briefing is injected into the target agent's first context.</p>
      <div class="row">
        <div class="field" style="flex:0 0 140px"><label>Channel</label>
          <select id="ho-channel"><option value="telegram">telegram</option><option value="whatsapp">whatsapp</option></select>
        </div>
        <div class="field" style="flex:1 1 180px"><label>Chat id</label>
          <input id="ho-chatid" placeholder="1816212449 or +21612345678" />
        </div>
        <div class="field" style="flex:0 0 140px"><label>Account (optional)</label>
          <input id="ho-account" placeholder="default" />
        </div>
        <div class="field" style="flex:1 1 180px"><label>Transfer to</label>
          <select id="ho-target"></select>
        </div>
      </div>
      <div class="field">
        <label>Briefing summary (one-shot note for the receiving agent)</label>
        <textarea id="ho-summary" style="min-height:90px" placeholder="Customer is asking about enterprise pricing. They've already seen the standard tier..."></textarea>
      </div>
      <div class="row" style="align-items:flex-end">
        <div class="field" style="flex:0 0 200px"><label>Expires (optional ISO)</label>
          <input id="ho-expires" placeholder="2026-04-20T00:00:00Z" />
        </div>
        <button id="btn-handover" class="primary">Hand off</button>
      </div>
    </div>

    <div class="card">
      <h2 style="margin:0 0 8px;font-size:14px">Incoming — chats routed TO this agent</h2>
      <div id="ho-incoming" class="empty">loading…</div>
    </div>

    <div class="card">
      <h2 style="margin:0 0 8px;font-size:14px">Outgoing — chats routed AWAY from this agent</h2>
      <div id="ho-outgoing" class="empty">loading…</div>
    </div>
  </section>

  <!-- Activity -->
  <section class="tab" id="tab-activity">
    <div class="card"><div id="activity" class="empty">loading…</div></div>
  </section>
</main>

<!-- Confirm modal -->
<div class="modal" id="confirm-modal" aria-hidden="true">
  <div class="modal-card">
    <h3 id="confirm-title">Confirm</h3>
    <div class="detail" id="confirm-detail"></div>
    <div class="row">
      <button id="confirm-cancel">Cancel</button>
      <button id="confirm-ok" class="primary">Run</button>
    </div>
  </div>
</div>

<script src="https://unpkg.com/easymde/dist/easymde.min.js"></script>
<script>
const AGENT_ID = ${JSON.stringify(agentId)};
const $ = (id) => document.getElementById(id);
const state = { agent: null, activeSkill: null, activeSkillFile: null, identityPath: null };

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (window.AX_LOCAL_TOKEN) headers['Authorization'] = 'Bearer ' + window.AX_LOCAL_TOKEN;
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function showMsg(kind, text){ const m = $('msg'); m.className='msg '+kind; m.textContent=text; setTimeout(()=>{m.className='msg';}, 4000); }

// --- confirm modal ---
function confirmAction(title, detail, onConfirm){
  $('confirm-title').textContent = title;
  $('confirm-detail').textContent = detail;
  const modal = $('confirm-modal');
  modal.setAttribute('aria-hidden', 'false');
  const cleanup = () => {
    modal.setAttribute('aria-hidden', 'true');
    $('confirm-ok').onclick = null;
    $('confirm-cancel').onclick = null;
  };
  $('confirm-ok').onclick = () => { cleanup(); onConfirm(); };
  $('confirm-cancel').onclick = cleanup;
}

// --- Tabs ---
for (const btn of document.querySelectorAll('nav.tabs button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('section.tab').forEach(s=>s.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'skills' && !state.agent?.skillsLoaded) loadSkills();
    if (btn.dataset.tab === 'identity' && !state.agent?.identityLoaded) loadIdentity();
    if (btn.dataset.tab === 'channels') loadChannels();
    if (btn.dataset.tab === 'handovers') loadHandovers();
    if (btn.dataset.tab === 'activity') loadActivity();
  });
}

// --- EasyMDE instances ---
let spMde, idMde, skMde;
function makeMde(el){
  return new EasyMDE({
    element: el, spellChecker: false, status: ['lines','words'],
    autoDownloadFontAwesome: true, autofocus: false,
    toolbar: ['bold','italic','heading','|','quote','code','unordered-list','ordered-list','|','link','image','table','|','preview','side-by-side','fullscreen','|','guide'],
  });
}

// --- Overview ---
async function loadAgent(){
  try {
    const a = await req('GET', '/api/admin/agent/' + AGENT_ID);
    state.agent = a;
    $('a-name').textContent = a.name || AGENT_ID;
    $('a-id').textContent = AGENT_ID + ' · ' + (a.workspace || '—');
    const chips = [
      a.tier && '<span class="chip accent">'+esc(a.tier)+'</span>',
      a.model && '<span class="chip">'+esc(a.model)+'</span>',
      a.access && '<span class="chip">'+esc(a.access)+'</span>',
      ...(a.mentions || []).map(m => '<span class="chip">'+esc(m)+'</span>'),
    ].filter(Boolean).join('');
    $('a-chips').innerHTML = chips;
    $('f-name').value = a.name || '';
    $('f-tier').value = a.tier || 'claude-code';
    $('f-model').value = a.model || '';
    $('f-access').value = a.access || 'private';
    $('f-maxc').value = a.maxConcurrent ?? 1;
    $('f-maxt').value = a.maxExecutionMinutes ?? 20;
    $('f-pmode').value = a.permissionMode || 'default';
    $('f-mentions').value = (a.mentions || []).join(', ');
    if (!spMde) spMde = makeMde($('sp-editor'));
    spMde.value(a.systemPrompt || '');
  } catch (e) { showMsg('err', e.message); }
}

$('btn-save-meta').addEventListener('click', async () => {
  const body = {
    name: $('f-name').value.trim(),
    tier: $('f-tier').value,
    model: $('f-model').value.trim(),
    access: $('f-access').value,
    maxConcurrent: Number($('f-maxc').value) || 1,
    maxExecutionMinutes: Number($('f-maxt').value) || 20,
    permissionMode: $('f-pmode').value,
    mentions: $('f-mentions').value.split(',').map(s=>s.trim()).filter(Boolean),
    systemPrompt: spMde ? spMde.value() : '',
  };
  try {
    await req('PATCH', '/api/admin/agent/' + AGENT_ID, body);
    showMsg('ok', 'Saved. Restart the daemon for tier/model changes to take effect.');
  } catch (e) { showMsg('err', e.message); }
});

// --- Identity ---
async function loadIdentity(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/identity');
    const sel = $('id-select');
    sel.innerHTML = r.identity.map(f =>
      '<option value="'+esc(f.path)+'" '+(f.exists?'':'data-new="1"')+'>'+esc(f.title)+(f.exists?'':' (new)')+'</option>'
    ).join('');
    sel.onchange = loadIdentityFile;
    if (!idMde) idMde = makeMde($('id-editor'));
    if (r.identity.length) {
      sel.value = r.identity[0].path;
      await loadIdentityFile();
    }
    state.agent.identityLoaded = true;
  } catch (e) { showMsg('err', e.message); }
}

async function loadIdentityFile(){
  const p = $('id-select').value;
  $('id-path').textContent = p;
  state.identityPath = p;
  try {
    const f = await req('GET', '/api/admin/agent/' + AGENT_ID + '/identity/file?path=' + encodeURIComponent(p));
    idMde.value(f.content || '');
  } catch (e) { showMsg('err', e.message); idMde.value(''); }
}

$('btn-save-id').addEventListener('click', async () => {
  if (!state.identityPath) return;
  try {
    await req('PUT', '/api/admin/agent/' + AGENT_ID + '/identity/file', {
      path: state.identityPath, content: idMde.value(),
    });
    showMsg('ok', 'Saved ' + state.identityPath);
  } catch (e) { showMsg('err', e.message); }
});

// --- Skills ---
async function loadSkills(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills');
    const list = $('skills-list');
    if (!r.skills.length) {
      list.innerHTML = '<div class="empty">No skills. Install a package or create one below.</div>';
    } else {
      list.innerHTML = r.skills.map(s =>
        '<div class="skill-row" data-slug="'+esc(s.slug)+'">'
        + '<span>'+esc(s.title)+'<br><span class="slug">'+esc(s.slug)+'</span></span>'
        + '</div>'
      ).join('');
      list.querySelectorAll('[data-slug]').forEach(r=>r.addEventListener('click', ()=>selectSkill(r.dataset.slug)));
    }
    state.agent.skillsLoaded = true;
  } catch (e) { showMsg('err', e.message); }
}

async function selectSkill(slug){
  state.activeSkill = slug;
  state.activeSkillFile = null;
  document.querySelectorAll('#skills-list [data-slug]').forEach(r=>{
    r.classList.toggle('active', r.dataset.slug === slug);
  });
  $('btn-delete-skill').disabled = false;
  $('btn-install-deps').disabled = true;
  $('sk-editor-wrap').style.display = 'none';
  $('sk-editor-empty').style.display = 'block';
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills/tree?slug=' + encodeURIComponent(slug));
    $('btn-install-deps').disabled = !r.deps?.manager;
    $('btn-install-deps').title = r.deps?.command || 'No package manifest detected';
    const host = $('skill-tree');
    host.innerHTML = r.tree.map(e => {
      const depth = (e.path.match(/\\//g) || []).length;
      const pad = 'padding-left:' + (depth * 10) + 'px';
      const icon = e.kind === 'dir' ? '▸' : '·';
      const cls = 'tree-entry ' + e.kind + (e.editable ? '' : ' readonly');
      return '<div class="'+cls+'" style="'+pad+'" data-path="'+esc(e.path)+'" data-editable="'+(e.editable?'1':'0')+'">'
        + '<span>'+icon+' '+esc(e.path.split('/').filter(Boolean).pop() || e.path)+'</span>'
        + '<span style="color:var(--ax-muted);font-size:10px">'+(e.kind==='file'?formatBytes(e.size):'')+'</span>'
      + '</div>';
    }).join('');
    host.querySelectorAll('[data-path]').forEach(r=>r.addEventListener('click', ()=>{
      if (r.dataset.editable === '1') openSkillFile(r.dataset.path);
    }));
    // Auto-open SKILL.md
    const skillMd = r.tree.find(e => e.path === 'SKILL.md' && e.editable);
    if (skillMd) openSkillFile('SKILL.md');
  } catch (e) { showMsg('err', e.message); }
}

function formatBytes(n){ if (!n) return ''; if (n < 1024) return n+'b'; if (n<1048576) return (n/1024).toFixed(1)+'k'; return (n/1048576).toFixed(1)+'M'; }

async function openSkillFile(path){
  state.activeSkillFile = path;
  $('sk-path').textContent = state.activeSkill + '/' + path;
  $('sk-editor-empty').style.display = 'none';
  $('sk-editor-wrap').style.display = 'flex';
  document.querySelectorAll('#skill-tree [data-path]').forEach(r=>r.classList.toggle('active', r.dataset.path === path));
  try {
    const f = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills/file?slug=' + encodeURIComponent(state.activeSkill) + '&path=' + encodeURIComponent(path));
    // Use EasyMDE for .md, plain textarea for everything else
    const isMd = path.toLowerCase().endsWith('.md') || path.toLowerCase().endsWith('.markdown');
    $('sk-editor').classList.toggle('plain-editor', !isMd);
    if (skMde) { skMde.toTextArea(); skMde = null; }
    if (isMd) {
      skMde = makeMde($('sk-editor'));
      skMde.value(f.content || '');
    } else {
      $('sk-editor').value = f.content || '';
    }
  } catch (e) { showMsg('err', e.message); }
}

$('btn-save-sk').addEventListener('click', async () => {
  if (!state.activeSkill || !state.activeSkillFile) return;
  const content = skMde ? skMde.value() : $('sk-editor').value;
  try {
    await req('PUT', '/api/admin/agent/' + AGENT_ID + '/skills/file', {
      slug: state.activeSkill, path: state.activeSkillFile, content,
    });
    showMsg('ok', 'Saved ' + state.activeSkill + '/' + state.activeSkillFile);
  } catch (e) { showMsg('err', e.message); }
});

$('btn-new-skill').addEventListener('click', async () => {
  const slug = prompt('New skill slug (lowercase, letters/digits/-/_):');
  if (!slug) return;
  try {
    await req('POST', '/api/admin/agent/' + AGENT_ID + '/skills', { slug });
    showMsg('ok', 'Skill created: ' + slug);
    await loadSkills();
    selectSkill(slug);
  } catch (e) { showMsg('err', e.message); }
});

$('btn-delete-skill').addEventListener('click', () => {
  if (!state.activeSkill) return;
  const slug = state.activeSkill;
  confirmAction(
    'Delete skill "' + slug + '"?',
    'This removes .claude/skills/' + slug + ' and all files inside it. This cannot be undone.',
    async () => {
      try {
        await req('DELETE', '/api/admin/agent/' + AGENT_ID + '/skills', { slug });
        state.activeSkill = null;
        state.activeSkillFile = null;
        $('skill-tree').innerHTML = '';
        $('sk-editor-wrap').style.display = 'none';
        $('sk-editor-empty').style.display = 'block';
        $('btn-delete-skill').disabled = true;
        $('btn-install-deps').disabled = true;
        showMsg('ok', 'Deleted ' + slug);
        loadSkills();
      } catch (e) { showMsg('err', e.message); }
    }
  );
});

$('btn-install-pkg').addEventListener('click', () => {
  const pkg = $('pkg-input').value.trim();
  if (!pkg) { showMsg('err', 'Enter a package like "owner/repo".'); return; }
  const worker = state.agent?.draftAgent || state.agent?.defaultWorker || 'devops-agent';
  confirmAction(
    'Install skills.sh package?',
    'Package: ' + pkg + '\\n\\nWorker agent: ' + worker + '\\n\\nThe worker will run: npx skills add ' + pkg + '\\n\\nInside: ' + (state.agent?.workspace || '(agent workspace)') + '\\n\\nOutput will appear below.',
    async () => {
      $('dispatch-output').style.display = 'block';
      $('dispatch-output').textContent = 'Dispatching to ' + worker + '…';
      try {
        const r = await req('POST', '/api/admin/agent/' + AGENT_ID + '/skills/install', { package: pkg });
        $('dispatch-output').textContent = (r.content || '(no output)') + '\\n\\n-- done --';
        loadSkills();
      } catch (e) { $('dispatch-output').textContent = 'Error: ' + e.message; }
    }
  );
});

$('btn-install-deps').addEventListener('click', async () => {
  if (!state.activeSkill) return;
  const slug = state.activeSkill;
  try {
    const hint = await req('GET', '/api/admin/agent/' + AGENT_ID + '/skills/deps?slug=' + encodeURIComponent(slug));
    if (!hint.manager) { showMsg('err', 'No package manifest in skill dir.'); return; }
    const worker = state.agent?.draftAgent || state.agent?.defaultWorker || 'devops-agent';
    confirmAction(
      'Install dependencies?',
      'Skill: ' + slug + '\\nManifest: ' + hint.file + '\\nCommand: ' + hint.command + '\\n\\nWorker agent: ' + worker + '\\n\\nRunning install scripts executes third-party code. Confirm only if you trust this skill\\'s source.',
      async () => {
        $('dispatch-output').style.display = 'block';
        $('dispatch-output').textContent = 'Dispatching to ' + worker + '…';
        try {
          const r = await req('POST', '/api/admin/agent/' + AGENT_ID + '/skills/deps', { slug });
          $('dispatch-output').textContent = (r.content || '(no output)') + '\\n\\n-- done --';
        } catch (e) { $('dispatch-output').textContent = 'Error: ' + e.message; }
      }
    );
  } catch (e) { showMsg('err', e.message); }
});

// --- Channels + Activity ---
async function loadChannels(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/channels');
    const host = $('channels-list');
    if (!r.bindings.length) { host.innerHTML = '<div class="empty">No channel bindings.</div>'; return; }
    host.classList.remove('empty');
    host.innerHTML = r.bindings.map(b =>
      '<div class="kv"><b>'+esc(b.channel)+'</b>'
      + (b.account ? ' · <span class="chip">'+esc(b.account)+'</span>' : '')
      + ' · ' + esc(b.detail) + '</div>'
    ).join('');
  } catch (e) { showMsg('err', e.message); }
}

async function loadHandovers(){
  try {
    // Populate the "Transfer to" dropdown with every local agent except self.
    const targets = $('ho-target');
    if (!targets.options.length) {
      const raw = await fetch('/api/admin/state', { headers: window.AX_LOCAL_TOKEN ? { Authorization: 'Bearer ' + window.AX_LOCAL_TOKEN } : {} });
      const st = await raw.json();
      targets.innerHTML = (st.agents || [])
        .filter(a => a.id !== AGENT_ID)
        .map(a => '<option value="'+esc(a.id)+'">'+esc(a.name || a.id)+' ('+esc(a.id)+')</option>')
        .join('');
    }
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/handovers');
    renderHandoverList($('ho-incoming'), r.incoming, 'incoming');
    renderHandoverList($('ho-outgoing'), r.outgoing, 'outgoing');
  } catch (e) { showMsg('err', e.message); }
}

function renderHandoverList(host, list, direction){
  if (!list.length) {
    host.classList.add('empty');
    host.innerHTML = direction === 'incoming'
      ? 'No chats are currently routed to this agent.'
      : 'No chats are currently routed away from this agent.';
    return;
  }
  host.classList.remove('empty');
  host.innerHTML = list.map(o => {
    const who = direction === 'incoming' ? ('from ' + esc(o.fromAgent)) : ('to ' + esc(o.toAgent));
    const expires = o.expiresAt ? ' · expires ' + esc(o.expiresAt) : '';
    const consumed = o.summaryConsumedAt ? ' · briefing delivered' : (o.summary ? ' · briefing pending' : '');
    return '<div class="node-row">'
      + '<span class="chip">'+esc(o.channel)+'</span>'
      + '<span class="mono">'+esc(o.chatId)+(o.accountId ? ':'+esc(o.accountId) : '')+'</span>'
      + '<span class="muted" style="flex:1">'+who+' · since '+esc(o.createdAt)+expires+consumed+'</span>'
      + '<button class="danger" data-release="'+esc(o.channel)+'::'+esc(o.chatId)+'::'+esc(o.accountId || '')+'">Release</button>'
      + '</div>';
  }).join('');
  host.querySelectorAll('[data-release]').forEach(btn => btn.addEventListener('click', () => {
    const [ch, cid, acct] = btn.dataset.release.split('::');
    releaseHandover(ch, cid, acct || undefined);
  }));
}

async function releaseHandover(channel, chatId, accountId){
  if (!confirm('Release the handover for ' + channel + ':' + chatId + '? Routing will revert to the config default on the next message.')) return;
  try {
    await req('DELETE', '/api/admin/agent/' + AGENT_ID + '/handovers', { channel, chatId, accountId });
    showMsg('ok', 'Handover released.');
    loadHandovers();
  } catch (e) { showMsg('err', e.message); }
}

$('btn-handover').addEventListener('click', () => {
  const channel = $('ho-channel').value;
  const chatId = $('ho-chatid').value.trim();
  const accountId = $('ho-account').value.trim() || undefined;
  const toAgent = $('ho-target').value;
  const summary = $('ho-summary').value.trim() || undefined;
  const expiresAt = $('ho-expires').value.trim() || undefined;
  if (!chatId || !toAgent) { showMsg('err', 'chat id and target agent are required'); return; }
  confirmAction(
    'Hand off this chat?',
    channel + ':' + chatId + (accountId ? ':'+accountId : '') + '\\n\\n'
    + 'From: ' + AGENT_ID + '\\nTo: ' + toAgent + '\\n\\n'
    + 'Every next message from this chat will be routed to ' + toAgent + ' until you release the handover. '
    + (summary ? 'The target agent will see your briefing note on its first reply.' : 'No briefing note set — the target agent will not know why.'),
    async () => {
      try {
        await req('POST', '/api/admin/agent/' + AGENT_ID + '/handovers',
          { channel, chatId, accountId, toAgent, summary, expiresAt });
        $('ho-summary').value = '';
        showMsg('ok', 'Handed off.');
        loadHandovers();
      } catch (e) { showMsg('err', e.message); }
    }
  );
});

async function loadActivity(){
  try {
    const r = await req('GET', '/api/admin/agent/' + AGENT_ID + '/activity');
    const host = $('activity');
    host.classList.remove('empty');
    host.innerHTML =
      '<div class="kv"><b>Active</b>' + (r.activeTasks ?? 0) + '</div>' +
      '<div class="kv"><b>Total</b>' + (r.totalTasks ?? 0) + '</div>' +
      '<div class="kv"><b>Errors</b>' + (r.errors ?? 0) + '</div>' +
      '<div class="kv"><b>Last active</b>' + (r.lastActive || '—') + '</div>' +
      (r.lastSummary ? '<div class="kv"><b>Last task</b><span>'+esc((r.lastSummary.text || '').slice(0, 240))+'</span></div>' : '');
  } catch (e) { showMsg('err', e.message); }
}

$('btn-test-drive').addEventListener('click', () => {
  window.location.href = '/admin#agent=' + encodeURIComponent(AGENT_ID);
});

loadAgent();
</script>
${tokenScript}
${TOPBAR_SCRIPT}
</body>
</html>`
}

function escapeHtml(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  )
}
