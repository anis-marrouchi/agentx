import { existsSync, readFileSync, writeFileSync, rmSync } from "fs"
import { resolve } from "path"
import type { IncomingMessage, ServerResponse } from "http"
import { mutateAgentxConfig } from "./config-mutate"

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
      "DELETE /api/admin/agents": () => deleteAgent(body),
      "POST /api/admin/channels/telegram": () => addTelegramAccount(body),
      "DELETE /api/admin/channels/telegram": () => deleteTelegramAccount(body),
      "POST /api/admin/channels/telegram/toggle": () => toggleTelegram(body),
      "POST /api/admin/crons": () => addCron(body),
      "DELETE /api/admin/crons": () => deleteCron(body),
      "POST /api/admin/config/raw": () => replaceConfigRaw(body),
    }
    const key = `${req.method} ${path}`
    const handler = dispatch[key]
    if (!handler) { sendJson(res, 404, { error: `unknown admin endpoint: ${key}` }); return }
    const result = handler()
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
  return { exists: true, agents, telegram, crons, nodeName: cfg.node?.name }
}

// ========================================================================
// Mutations
// ========================================================================

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
  <button data-tab="advanced">Advanced</button>
</nav>
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
      <label>Prompt<span class="hint">(what the agent should do on every tick)</span></label>
      <textarea id="c-prompt" placeholder="Send me the weekly sales summary."></textarea>
      <div class="actions"><button class="primary" onclick="addCron()">Add schedule</button><div id="c-msg" class="msg"></div></div>
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
  } catch (e) {
    showMsg($('global-msg'), 'err', e.message);
  }
}

function renderAgents() {
  const list = $('agent-list');
  if (!state.agents.length) { list.innerHTML = '<div class="empty">No agents yet.</div>'; return; }
  list.innerHTML = '';
  for (const a of state.agents) {
    const div = document.createElement('div');
    div.className = 'row-card';
    div.innerHTML =
      '<div class="info"><h3>' + escapeHtml(a.name) + '</h3>' +
        '<div class="meta">' +
          '<span class="chip">' + escapeHtml(a.tier || '') + '</span>' +
          (a.model ? '<span class="chip">' + escapeHtml(a.model) + '</span>' : '') +
          '<b>' + escapeHtml(a.id) + '</b> · triggers: ' + (a.mentions.map(escapeHtml).join(', ') || '—') +
        '</div>' +
      '</div>' +
      '<button class="danger" data-id="' + escapeHtml(a.id) + '">Delete</button>';
    div.querySelector('button.danger').addEventListener('click', () => deleteAgent(a.id));
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
  };
  try {
    const r = await req('POST', '/api/admin/agents', body);
    showMsg($('a-msg'), 'ok', r.summary || 'Added.');
    $('a-id').value = ''; $('a-name').value = ''; $('a-triggers').value = ''; $('a-personality').value = '';
    refresh();
  } catch (e) { showMsg($('a-msg'), 'err', e.message); }
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
  });
}

refresh();
</script>
</body>
</html>`
}
