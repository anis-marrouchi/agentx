import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs"
import { resolve } from "path"
import { hostname } from "os"
import type { IncomingMessage, ServerResponse } from "http"
import { mutateAgentxConfig, writeAgentxConfig } from "./config-mutate"

// --- /setup wizard: form-driven first-run experience for non-technical operators ---
//
// This is the web equivalent of `agentx init` + `agentx agent add` + `agentx
// channel add`, collapsed into one page. It writes agentx.json and scaffolds
// the first agent's workspace so a business operator can go from a blank
// machine to a working AgentX install without editing JSON.
//
// The route lives on the board-dashboard server (port 4202) because that's the
// surface operators actually open. It talks to the loopback daemon for the
// post-install restart; the wizard itself never requires a running daemon.

export interface WizardPayload {
  nodeName: string
  agent: {
    id: string
    name: string
    triggerWords: string   // comma/space separated; we normalise on the server
    tier: "claude-code" | "sdk"
    model?: string
    personality?: string   // short free text → CLAUDE.md
  }
  telegram?: {
    accountId: string
    botToken: string
    botUsername?: string
  }
  anthropicApiKey?: string
}

/**
 * Return the current state of the working directory so the wizard can choose
 * between "fresh install" and "add another" flows.
 */
export function wizardState(baseDir: string = process.cwd()): {
  configExists: boolean
  agentCount: number
  channelCount: number
  nodeName?: string
} {
  const file = resolve(baseDir, "agentx.json")
  if (!existsSync(file)) return { configExists: false, agentCount: 0, channelCount: 0 }
  try {
    const cfg = JSON.parse(readFileSync(file, "utf-8"))
    const agents = cfg.agents ? Object.keys(cfg.agents).length : 0
    const channels = cfg.channels
      ? Object.values(cfg.channels).filter((c: any) => c && c.enabled).length
      : 0
    return { configExists: true, agentCount: agents, channelCount: channels, nodeName: cfg.node?.name }
  } catch {
    return { configExists: false, agentCount: 0, channelCount: 0 }
  }
}

/**
 * Execute the wizard submission. Returns a short human-readable summary of
 * what was written. Throws on validation error — the caller surfaces the
 * message to the user.
 */
export function runWizard(payload: WizardPayload, baseDir: string = process.cwd()): {
  summary: string
  nextSteps: string[]
  backupPath?: string
} {
  // --- validate ---
  if (!payload.nodeName?.trim()) throw new Error("Team name is required.")
  if (!payload.agent?.id?.trim()) throw new Error("Agent id is required.")
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(payload.agent.id)) {
    throw new Error("Agent id must be lowercase (letters, digits, -, _) and start with a letter or digit.")
  }
  if (!payload.agent.name?.trim()) throw new Error("Agent name is required.")
  const mentions = splitMentions(payload.agent.triggerWords)
  if (mentions.length === 0) throw new Error("At least one trigger word is required.")
  if (payload.agent.tier !== "claude-code" && payload.agent.tier !== "sdk") {
    throw new Error("AI engine must be claude-code or sdk.")
  }

  const configPath = resolve(baseDir, "agentx.json")
  const envPath = resolve(baseDir, ".env")
  const workspaceDir = resolve(baseDir, "agents", payload.agent.id)
  const state = wizardState(baseDir)

  // --- scaffold workspace ---
  mkdirSync(workspaceDir, { recursive: true })
  const claudeMd = resolve(workspaceDir, "CLAUDE.md")
  if (!existsSync(claudeMd)) {
    const personality = payload.agent.personality?.trim() || `You are ${payload.agent.name}, an assistant on the ${payload.nodeName} team.`
    writeFileSync(claudeMd, `# ${payload.agent.name}\n\n${personality}\n`)
  }

  // --- build / mutate agentx.json ---
  const telegramTokenRef = payload.telegram
    ? `TG_${payload.agent.id.toUpperCase()}_BOT_TOKEN`
    : undefined

  let backupPath: string | undefined
  if (!state.configExists) {
    const cfg = buildFreshConfig(payload, workspaceDir, mentions, telegramTokenRef)
    writeAgentxConfig(cfg, { configPath })
  } else {
    const result = mutateAgentxConfig((cfg) => {
      cfg.node = cfg.node || {}
      if (!cfg.node.name) cfg.node.name = payload.nodeName
      if (!cfg.node.id) cfg.node.id = slugify(payload.nodeName) || "team"
      if (!cfg.node.bind) cfg.node.bind = "127.0.0.1:18800"
      cfg.node.defaultAgent = cfg.node.defaultAgent || payload.agent.id

      cfg.providers = cfg.providers || {}
      if (!cfg.providers.claude) cfg.providers.claude = { apiKey: "${ANTHROPIC_API_KEY}" }

      cfg.agents = cfg.agents || {}
      if (cfg.agents[payload.agent.id]) throw new Error(`Agent "${payload.agent.id}" already exists.`)
      cfg.agents[payload.agent.id] = agentBlock(payload, workspaceDir, mentions)

      if (payload.telegram) {
        cfg.channels = cfg.channels || {}
        cfg.channels.telegram = cfg.channels.telegram || { enabled: true, accounts: {}, policy: { dm: "pair", group: "mention-required" } }
        cfg.channels.telegram.enabled = true
        cfg.channels.telegram.accounts = cfg.channels.telegram.accounts || {}
        cfg.channels.telegram.accounts[payload.telegram.accountId] = telegramAccountBlock(payload, telegramTokenRef!)
      }

      return { summary: `added agent "${payload.agent.id}"` + (payload.telegram ? " + telegram account" : "") }
    }, { configPath })
    backupPath = result.backupPath
  }

  // --- write / append .env ---
  ensureEnvEntries(envPath, payload, telegramTokenRef)

  const nextSteps: string[] = []
  if (payload.anthropicApiKey || !existsSync(resolve(baseDir, ".env"))) {
    nextSteps.push("Double-check the API keys in .env")
  }
  if (payload.agent.tier === "claude-code") {
    nextSteps.push("Run  claude --version  to confirm Claude Code is installed (needed for the claude-code engine)")
  }
  nextSteps.push("Start the daemon:  agentx daemon start")
  nextSteps.push("Open the dashboard:  http://127.0.0.1:4202")

  return {
    summary: state.configExists
      ? `Added agent "${payload.agent.id}" to your team.`
      : `Initialized your team with first agent "${payload.agent.id}".`,
    nextSteps,
    backupPath,
  }
}

function splitMentions(s: string): string[] {
  return (s || "")
    .split(/[,\s]+/)
    .map((m) => m.trim())
    .filter(Boolean)
    // Normalise: ensure @-prefix entries stay, plain ones are kept as-is.
    .filter((m, i, a) => a.indexOf(m) === i)
}

function slugify(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
}

function buildFreshConfig(payload: WizardPayload, workspaceDir: string, mentions: string[], telegramTokenRef?: string) {
  const id = slugify(payload.nodeName) || "team"
  const cfg: any = {
    node: { id, name: payload.nodeName, bind: "127.0.0.1:18800", defaultAgent: payload.agent.id },
    providers: { claude: { apiKey: "${ANTHROPIC_API_KEY}" } },
    agents: { [payload.agent.id]: agentBlock(payload, workspaceDir, mentions) },
    channels: {},
    crons: {},
    mesh: { enabled: false, peers: [], discovery: "static", healthCheck: { interval: 60, timeout: 10 } },
    dashboard: { enabled: true, port: 4202, bind: "127.0.0.1", daemonUrl: "http://localhost:18800" },
    boards: [],
  }
  if (payload.telegram && telegramTokenRef) {
    cfg.channels.telegram = {
      enabled: true,
      accounts: { [payload.telegram.accountId]: telegramAccountBlock(payload, telegramTokenRef) },
      policy: { dm: "pair", group: "mention-required" },
    }
  } else {
    cfg.channels.telegram = { enabled: false, accounts: {}, policy: { dm: "pair", group: "mention-required" } }
  }
  return cfg
}

function agentBlock(payload: WizardPayload, workspaceDir: string, mentions: string[]) {
  const block: any = {
    name: payload.agent.name,
    workspace: workspaceDir,
    tier: payload.agent.tier,
    mentions,
    maxConcurrent: 2,
    permissionMode: "default",
  }
  if (payload.agent.model) block.model = payload.agent.model
  if (payload.agent.personality?.trim()) block.systemPrompt = payload.agent.personality.trim().slice(0, 400)
  return block
}

function telegramAccountBlock(payload: WizardPayload, tokenRef: string) {
  return {
    botToken: "${" + tokenRef + "}",
    botUsername: payload.telegram?.botUsername || "",
    agentBinding: payload.agent.id,
  }
}

function ensureEnvEntries(envPath: string, payload: WizardPayload, telegramTokenRef?: string): void {
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : ""
  const lines: string[] = []

  if (payload.anthropicApiKey && !existing.includes("ANTHROPIC_API_KEY=")) {
    lines.push(`ANTHROPIC_API_KEY=${payload.anthropicApiKey}`)
  }
  if (payload.telegram && telegramTokenRef && !existing.includes(`${telegramTokenRef}=`)) {
    lines.push(`${telegramTokenRef}=${payload.telegram.botToken}`)
  }

  if (!existsSync(envPath)) {
    const header = [
      "# AgentX environment variables",
      "# (Never commit this file — it contains secrets.)",
      "",
    ]
    writeFileSync(envPath, [...header, ...lines, ""].join("\n"))
    return
  }
  if (lines.length > 0) {
    const sep = existing.endsWith("\n") ? "" : "\n"
    appendFileSync(envPath, sep + lines.join("\n") + "\n")
  }
}

// --- HTTP handlers used by board-dashboard.ts ---

export function handleWizardGet(_req: IncomingMessage, res: ServerResponse): void {
  const state = wizardState()
  const html = renderWizardHtml(state)
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(html)
}

export async function handleWizardPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw = ""
  await new Promise<void>((ok) => { req.on("data", (c) => { raw += c }); req.on("end", () => ok()) })
  let payload: WizardPayload
  try { payload = JSON.parse(raw) }
  catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid JSON" })); return }
  try {
    const result = runWizard(payload)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(result))
  } catch (e: any) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: e.message || "wizard failed" }))
  }
}

function renderWizardHtml(state: ReturnType<typeof wizardState>): string {
  const heading = state.configExists
    ? (state.agentCount === 0 ? "Add your first agent" : "Add another agent")
    : "Set up your team"
  const defaultNode = state.nodeName || hostname().replace(/\.local$/, "")
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentX — Setup</title>
<style>
:root{--bg:#0b0d14;--card:#151823;--border:#2a2d3a;--text:#e6e8ef;--muted:#8b8fa3;--accent:#6366f1;--green:#22c55e;--red:#ef4444}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:18px 24px;border-bottom:1px solid var(--border);background:#10131c;display:flex;align-items:center;gap:12px}
header .brand{font-weight:600;color:var(--accent);font-size:15px}
header .sub{color:var(--muted);font-weight:500}
.spacer{flex:1}
a.link{color:var(--muted);text-decoration:none;font-size:13px;padding:4px 10px;border:1px solid var(--border);border-radius:6px}
a.link:hover{color:var(--accent);border-color:var(--accent)}
main{max-width:620px;margin:0 auto;padding:32px 22px 60px}
h1{font-size:24px;margin:0 0 6px}
.lead{color:var(--muted);margin:0 0 26px}
section.step{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px 22px;margin:14px 0}
section.step h2{font-size:14px;font-weight:600;margin:0 0 14px;color:var(--text);display:flex;align-items:center;gap:10px}
section.step h2 .num{background:var(--accent);color:#fff;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
label{display:block;margin:10px 0 4px;font-size:12px;color:var(--muted)}
label .hint{color:var(--muted);font-weight:400;font-size:11px;margin-left:6px}
input,textarea,select{width:100%;background:#0e1119;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font:13px/1.4 inherit}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent)}
textarea{resize:vertical;min-height:70px;font-family:inherit}
.row{display:flex;gap:10px}
.row > *{flex:1}
.toggle{display:flex;align-items:center;gap:8px;margin:14px 0 4px;font-size:13px;color:var(--text);cursor:pointer}
.toggle input{width:auto}
.optional{border-left:2px solid var(--border);padding-left:14px;margin-top:10px;display:none}
.optional.show{display:block}
footer.actions{display:flex;gap:10px;padding:20px 0;align-items:center}
button.primary{background:var(--accent);color:#fff;border:none;border-radius:6px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer}
button.primary:hover{filter:brightness(1.1)}
button.primary:disabled{opacity:0.5;cursor:not-allowed}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:9px 16px;cursor:pointer}
.hint-block{font-size:11px;color:var(--muted);margin-top:6px;line-height:1.55}
.hint-block code{background:#10131c;padding:1px 6px;border-radius:3px;color:var(--text);font-family:ui-monospace,monospace;font-size:11px}
#msg{margin:14px 0;padding:12px 16px;border-radius:6px;font-size:13px;display:none}
#msg.ok{display:block;background:rgba(34,197,94,0.12);color:var(--green);border:1px solid rgba(34,197,94,0.3)}
#msg.err{display:block;background:rgba(239,68,68,0.12);color:var(--red);border:1px solid rgba(239,68,68,0.3)}
#next-steps{margin-top:12px;padding-left:20px}
#next-steps li{margin:4px 0}
#next-steps code{background:#10131c;padding:1px 6px;border-radius:3px;color:var(--text);font-family:ui-monospace,monospace;font-size:12px}
.config-banner{background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.3);border-radius:6px;padding:10px 14px;margin-bottom:16px;color:var(--muted);font-size:12px}
.config-banner b{color:var(--text)}
</style>
</head>
<body>
<header>
  <div class="brand">AgentX <span class="sub">· Setup</span></div>
  <div class="spacer"></div>
  <a href="/glossary" class="link">? Glossary</a>
  <a href="/live" class="link">Skip — open dashboard</a>
</header>
<main>
  <h1>${escapeHtml(heading)}</h1>
  <p class="lead">Fill in the basics below. We'll write <code>agentx.json</code>, set up a folder for your first agent, and point you at the next step.</p>

  ${state.configExists ? `<div class="config-banner">Existing install: <b>${state.agentCount}</b> agent(s), <b>${state.channelCount}</b> channel(s) already configured. This wizard will add to it.</div>` : ""}

  <div id="msg"></div>

  <form id="wizard" autocomplete="off">
    <section class="step">
      <h2><span class="num">1</span>Team basics</h2>
      <label>Team name<span class="hint">(what you'd call this AgentX install)</span></label>
      <input name="nodeName" value="${escapeHtml(defaultNode)}" placeholder="My Team" required />
    </section>

    <section class="step">
      <h2><span class="num">2</span>First agent</h2>
      <div class="row">
        <div>
          <label>Agent name</label>
          <input name="agentName" value="Assistant" placeholder="Support Bot" required />
        </div>
        <div>
          <label>Agent id<span class="hint">(lowercase, no spaces)</span></label>
          <input name="agentId" value="assistant" pattern="[a-z0-9][a-z0-9_-]*" required />
        </div>
      </div>
      <label>Trigger words<span class="hint">(words that activate this agent — comma or space separated, e.g. <code>@support, support</code>)</span></label>
      <input name="triggerWords" value="@assistant, assistant" required />
      <div class="row">
        <div>
          <label>AI engine</label>
          <select name="tier">
            <option value="claude-code">Claude Code (recommended)</option>
            <option value="sdk">Anthropic API (BYO key)</option>
          </select>
        </div>
        <div>
          <label>Model<span class="hint">(optional)</span></label>
          <input name="model" value="claude-sonnet-4-6" placeholder="claude-sonnet-4-6" />
        </div>
      </div>
      <label>Personality / instructions<span class="hint">(optional — what this agent does, in plain English)</span></label>
      <textarea name="personality" placeholder="You are a support agent for Acme Co. Answer customer questions about our product, be friendly, keep replies short."></textarea>
    </section>

    <section class="step">
      <h2><span class="num">3</span>First channel</h2>
      <label class="toggle"><input type="checkbox" id="enableTelegram" /> Connect Telegram now</label>
      <div class="optional" id="telegramFields">
        <label>Account id<span class="hint">(a label you choose — e.g. <code>support</code>)</span></label>
        <input name="telegramAccountId" value="default" />
        <label>Bot token<span class="hint">(from <a href="https://t.me/BotFather" target="_blank" style="color:var(--accent)">@BotFather</a>)</span></label>
        <input name="telegramBotToken" placeholder="123456:ABCdef..." />
        <label>Bot username<span class="hint">(optional — e.g. <code>my_support_bot</code>)</span></label>
        <input name="telegramBotUsername" placeholder="my_support_bot" />
      </div>
    </section>

    <section class="step">
      <h2><span class="num">4</span>Anthropic API key</h2>
      <label>API key<span class="hint">(optional if you'll paste it into <code>.env</code> manually, or if you're only using Claude Code)</span></label>
      <input name="anthropicApiKey" type="password" placeholder="sk-ant-…" autocomplete="off" />
      <div class="hint-block">
        The key is written to <code>.env</code> as <code>ANTHROPIC_API_KEY</code>. AgentX never transmits it — everything stays on this machine.
      </div>
    </section>

    <footer class="actions">
      <button type="submit" class="primary" id="submitBtn">Save and continue</button>
      <button type="button" class="ghost" onclick="window.location.href='/live'">Skip, I'll do it later</button>
    </footer>
  </form>
</main>
<script>
document.getElementById('enableTelegram').addEventListener('change', (e) => {
  document.getElementById('telegramFields').classList.toggle('show', e.target.checked);
});
document.getElementById('wizard').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = document.getElementById('msg');
  const btn = document.getElementById('submitBtn');
  msg.className = ''; msg.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Saving…';
  const telegramEnabled = document.getElementById('enableTelegram').checked;
  const payload = {
    nodeName: f.nodeName.value.trim(),
    agent: {
      id: f.agentId.value.trim(),
      name: f.agentName.value.trim(),
      triggerWords: f.triggerWords.value.trim(),
      tier: f.tier.value,
      model: f.model.value.trim() || undefined,
      personality: f.personality.value.trim() || undefined,
    },
    anthropicApiKey: f.anthropicApiKey.value.trim() || undefined,
  };
  if (telegramEnabled) {
    payload.telegram = {
      accountId: f.telegramAccountId.value.trim() || 'default',
      botToken: f.telegramBotToken.value.trim(),
      botUsername: f.telegramBotUsername.value.trim() || undefined,
    };
    if (!payload.telegram.botToken) {
      msg.className = 'err'; msg.textContent = 'Bot token is required when Telegram is enabled.';
      btn.disabled = false; btn.textContent = 'Save and continue'; return;
    }
  }
  try {
    const r = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agentx-wizard' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    const steps = data.nextSteps.map((s) => '<li>' + s.replace(/\`([^\`]+)\`/g, '<code>$1</code>') + '</li>').join('');
    msg.className = 'ok';
    msg.innerHTML = '<b>' + data.summary + '</b><ol id="next-steps">' + steps + '</ol>';
    btn.textContent = 'Done';
    btn.disabled = true;
  } catch (err) {
    msg.className = 'err'; msg.textContent = err.message;
    btn.disabled = false; btn.textContent = 'Save and continue';
  }
});
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}
