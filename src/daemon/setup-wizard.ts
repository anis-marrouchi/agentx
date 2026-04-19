import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs"
import { resolve } from "path"
import { hostname } from "os"
import type { IncomingMessage, ServerResponse } from "http"
import { mutateAgentxConfig, writeAgentxConfig } from "./config-mutate"
import { TOPBAR_HEAD, TOPBAR_CSS, TOPBAR_SCRIPT } from "./topbar"

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
${TOPBAR_HEAD}
<style>
/* --- Shared design tokens (mirror of LIVE_CSS :root) --- */
:root {
  --ax-bg: oklch(0.16 0.010 265);
  --ax-bg-elev: oklch(0.19 0.012 265);
  --ax-surface: oklch(0.21 0.012 265);
  --ax-surface-2: oklch(0.24 0.014 265);
  --ax-border: oklch(0.29 0.014 265);
  --ax-border-2: oklch(0.35 0.016 265);
  --ax-text: oklch(0.95 0.005 265);
  --ax-text-2: oklch(0.80 0.008 265);
  --ax-muted: oklch(0.60 0.010 265);
  --ax-accent: oklch(0.78 0.13 165);
  --ax-warn: oklch(0.80 0.14 75);
  --ax-err: oklch(0.68 0.19 25);
  --ax-font: "IBM Plex Sans", -apple-system, "Segoe UI", sans-serif;
  --ax-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Consolas, monospace;
  --ax-fs: 13px;
  --ax-fs-sm: 12px;
  --ax-fs-xs: 11px;
  --ax-radius: 6px;
  --ax-pad: 16px;
  --ax-gap: 12px;
  color-scheme: dark;
}
[data-theme="light"] {
  --ax-bg: oklch(0.98 0.002 265);
  --ax-bg-elev: oklch(0.96 0.003 265);
  --ax-surface: oklch(0.99 0.002 265);
  --ax-surface-2: oklch(0.955 0.003 265);
  --ax-border: oklch(0.88 0.006 265);
  --ax-border-2: oklch(0.78 0.008 265);
  --ax-text: oklch(0.22 0.010 265);
  --ax-text-2: oklch(0.36 0.010 265);
  --ax-muted: oklch(0.54 0.010 265);
  --ax-accent: oklch(0.55 0.14 165);
  color-scheme: light;
}
[data-theme="crt"] {
  --ax-bg: #05140a;
  --ax-bg-elev: #061a0d;
  --ax-surface: #08201f;
  --ax-surface-2: #0b2922;
  --ax-border: #164a30;
  --ax-border-2: #1f6a44;
  --ax-text: #b7ffcc;
  --ax-text-2: #83e3a8;
  --ax-muted: #4f9a73;
  --ax-accent: #6dff9e;
  --ax-font: "IBM Plex Mono", ui-monospace, monospace;
}

* { box-sizing: border-box; }
html, body {
  margin: 0; min-height: 100vh;
  background: var(--ax-bg); color: var(--ax-text);
  font-family: var(--ax-font); font-size: var(--ax-fs);
  -webkit-font-smoothing: antialiased;
}
code, .ax-mono { font-family: var(--ax-mono); letter-spacing: -0.01em; }
a { color: var(--ax-accent); text-decoration: none; }
a:hover { text-decoration: underline; }

${TOPBAR_CSS}

/* Setup-specific: we don't render the full tab bar on /setup — just brand,
 * subtitle, theme switcher, and a "skip" link that goes to the dashboard. */
.ax-topbar__right a.ax-skip {
  padding: 4px 10px; border: 1px solid var(--ax-border-2); border-radius: 4px;
  color: var(--ax-text-2); font-size: var(--ax-fs-xs); text-decoration: none;
}
.ax-topbar__right a.ax-skip:hover {
  color: var(--ax-accent); border-color: var(--ax-accent);
}

/* --- Main wizard layout --- */
main.ax-wizard {
  max-width: 680px; margin: 0 auto; padding: 36px 22px 80px;
}
.ax-wizard__h1 {
  font-size: 22px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.015em;
}
.ax-wizard__lead {
  color: var(--ax-muted); margin: 0 0 24px; font-size: var(--ax-fs);
  line-height: 1.55;
}
.ax-wizard__lead code {
  background: var(--ax-surface-2); padding: 1px 6px; border-radius: 3px;
  color: var(--ax-text); font-size: var(--ax-fs-sm);
}

.ax-banner {
  background: color-mix(in oklch, var(--ax-accent) 10%, var(--ax-bg-elev));
  border: 1px solid color-mix(in oklch, var(--ax-accent) 30%, var(--ax-border-2));
  border-radius: var(--ax-radius);
  padding: 10px 14px; margin-bottom: 18px;
  color: var(--ax-text-2); font-size: var(--ax-fs-sm);
}
.ax-banner b { color: var(--ax-text); font-weight: 600; }

/* Step cards — mirror the .ax-card look from live */
.ax-step {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: 8px; padding: 20px 22px; margin: 14px 0;
}
.ax-step__head {
  font-size: var(--ax-fs-xs); font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--ax-muted);
  margin: 0 0 14px; display: flex; align-items: center; gap: 10px;
}
.ax-step__num {
  width: 22px; height: 22px; border-radius: 4px;
  background: color-mix(in oklch, var(--ax-accent) 15%, var(--ax-surface));
  border: 1px solid color-mix(in oklch, var(--ax-accent) 45%, var(--ax-border-2));
  color: var(--ax-accent);
  display: inline-flex; align-items: center; justify-content: center;
  font-family: var(--ax-mono); font-size: 11px; font-weight: 700;
  letter-spacing: 0; text-transform: none;
}

/* Form fields */
.ax-field { margin: 10px 0 0; }
.ax-field:first-child { margin-top: 0; }
.ax-field label {
  display: block; margin-bottom: 5px;
  font-size: var(--ax-fs-xs); color: var(--ax-muted);
  text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500;
}
.ax-field label .ax-hint {
  text-transform: none; letter-spacing: 0; color: var(--ax-muted);
  font-weight: 400; font-size: var(--ax-fs-xs); margin-left: 6px;
}
.ax-field input, .ax-field textarea, .ax-field select {
  width: 100%;
  background: var(--ax-bg); color: var(--ax-text);
  border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius);
  padding: 8px 10px; font: inherit; font-size: var(--ax-fs);
  transition: border-color 0.1s ease;
}
.ax-field input:focus, .ax-field textarea:focus, .ax-field select:focus {
  outline: none;
  border-color: var(--ax-accent);
  box-shadow: 0 0 0 2px color-mix(in oklch, var(--ax-accent) 18%, transparent);
}
.ax-field textarea { resize: vertical; min-height: 72px; font-family: var(--ax-font); }
.ax-field input::placeholder, .ax-field textarea::placeholder { color: var(--ax-muted); opacity: 0.7; }

.ax-row { display: flex; gap: 12px; }
.ax-row > * { flex: 1; }

.ax-toggle {
  display: flex; align-items: center; gap: 8px; margin: 4px 0 6px;
  font-size: var(--ax-fs); color: var(--ax-text); cursor: pointer;
  user-select: none;
}
.ax-toggle input { width: auto; accent-color: var(--ax-accent); }
.ax-optional {
  border-left: 2px solid var(--ax-border-2); padding-left: 14px;
  margin-top: 10px; display: none;
}
.ax-optional.is-show { display: block; }
.ax-hint-block {
  font-size: var(--ax-fs-xs); color: var(--ax-muted); margin-top: 8px; line-height: 1.55;
}
.ax-hint-block code {
  background: var(--ax-surface-2); padding: 1px 6px; border-radius: 3px;
  color: var(--ax-text); font-family: var(--ax-mono); font-size: var(--ax-fs-xs);
}

/* Action buttons — matches dashboard primary-button feel */
.ax-actions {
  display: flex; gap: 10px; padding: 20px 0 0; align-items: center;
  border-top: 1px solid var(--ax-border); margin-top: 20px;
}
.ax-btn {
  background: transparent; color: var(--ax-text-2);
  border: 1px solid var(--ax-border-2); border-radius: var(--ax-radius);
  padding: 8px 16px; font: inherit; font-size: var(--ax-fs); cursor: pointer;
  transition: border-color 0.1s, color 0.1s, background 0.1s;
}
.ax-btn:hover { color: var(--ax-text); border-color: var(--ax-accent); }
.ax-btn--primary {
  background: color-mix(in oklch, var(--ax-accent) 15%, var(--ax-surface));
  color: var(--ax-accent);
  border-color: color-mix(in oklch, var(--ax-accent) 50%, var(--ax-border-2));
  font-weight: 600;
}
.ax-btn--primary:hover {
  background: color-mix(in oklch, var(--ax-accent) 25%, var(--ax-surface));
  color: var(--ax-accent); border-color: var(--ax-accent);
}
.ax-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Result messaging */
.ax-msg { margin: 14px 0; padding: 12px 16px; border-radius: var(--ax-radius); font-size: var(--ax-fs); display: none; }
.ax-msg.is-ok {
  display: block;
  background: color-mix(in oklch, var(--ax-accent) 12%, transparent);
  color: var(--ax-accent);
  border: 1px solid color-mix(in oklch, var(--ax-accent) 40%, transparent);
}
.ax-msg.is-err {
  display: block;
  background: color-mix(in oklch, var(--ax-err) 12%, transparent);
  color: var(--ax-err);
  border: 1px solid color-mix(in oklch, var(--ax-err) 40%, transparent);
}
.ax-next-steps { margin-top: 12px; padding-left: 20px; color: var(--ax-text-2); }
.ax-next-steps li { margin: 4px 0; }
.ax-next-steps code {
  background: var(--ax-surface-2); padding: 1px 6px; border-radius: 3px;
  color: var(--ax-text); font-family: var(--ax-mono); font-size: var(--ax-fs-sm);
}
</style>
</head>
<body>
<header class="ax-topbar">
  <div class="ax-topbar__left">
    <div class="ax-brand">
      <span class="ax-brand__mark">AX</span>
      <span class="ax-brand__name">AgentX</span>
      <span class="ax-brand__subtitle">Setup</span>
    </div>
  </div>
  <div class="ax-topbar__right">
    <a href="/glossary" class="ax-skip">? Glossary</a>
    <a href="/live" class="ax-skip">Skip — open dashboard</a>
    <div class="ax-theme-switch" role="tablist" aria-label="Theme">
      <button data-theme-opt="dark">Dark</button>
      <button data-theme-opt="light">Light</button>
      <button data-theme-opt="crt">CRT</button>
    </div>
  </div>
</header>
<main class="ax-wizard">
  <h1 class="ax-wizard__h1">${escapeHtml(heading)}</h1>
  <p class="ax-wizard__lead">Fill in the basics below. We'll write <code>agentx.json</code>, set up a folder for your first agent, and point you at the next step.</p>

  ${state.configExists ? `<div class="ax-banner">Existing install: <b>${state.agentCount}</b> agent(s), <b>${state.channelCount}</b> channel(s) already configured. This wizard will add to it.</div>` : ""}

  <div id="msg" class="ax-msg"></div>

  <form id="wizard" autocomplete="off">
    <section class="ax-step">
      <div class="ax-step__head"><span class="ax-step__num">1</span>Team basics</div>
      <div class="ax-field">
        <label>Team name <span class="ax-hint">(what you'd call this AgentX install)</span></label>
        <input name="nodeName" value="${escapeHtml(defaultNode)}" placeholder="My Team" required />
      </div>
    </section>

    <section class="ax-step">
      <div class="ax-step__head"><span class="ax-step__num">2</span>First agent</div>
      <div class="ax-row">
        <div class="ax-field">
          <label>Agent name</label>
          <input name="agentName" value="Assistant" placeholder="Support Bot" required />
        </div>
        <div class="ax-field">
          <label>Agent id <span class="ax-hint">(lowercase, no spaces)</span></label>
          <input name="agentId" value="assistant" pattern="[a-z0-9][a-z0-9_-]*" required />
        </div>
      </div>
      <div class="ax-field">
        <label>Trigger words <span class="ax-hint">(comma or space separated — e.g. <code>@support, support</code>)</span></label>
        <input name="triggerWords" value="@assistant, assistant" required />
      </div>
      <div class="ax-row">
        <div class="ax-field">
          <label>AI engine</label>
          <select name="tier">
            <option value="claude-code">Claude Code (recommended)</option>
            <option value="sdk">Anthropic API (BYO key)</option>
          </select>
        </div>
        <div class="ax-field">
          <label>Model <span class="ax-hint">(optional)</span></label>
          <input name="model" value="claude-sonnet-4-6" placeholder="claude-sonnet-4-6" />
        </div>
      </div>
      <div class="ax-field">
        <label>Personality / instructions <span class="ax-hint">(optional — what this agent does, in plain English)</span></label>
        <textarea name="personality" placeholder="You are a support agent for Acme Co. Answer customer questions about our product, be friendly, keep replies short."></textarea>
      </div>
    </section>

    <section class="ax-step">
      <div class="ax-step__head"><span class="ax-step__num">3</span>First channel</div>
      <label class="ax-toggle"><input type="checkbox" id="enableTelegram" /> Connect Telegram now</label>
      <div class="ax-optional" id="telegramFields">
        <div class="ax-field">
          <label>Account id <span class="ax-hint">(a label you choose — e.g. <code>support</code>)</span></label>
          <input name="telegramAccountId" value="default" />
        </div>
        <div class="ax-field">
          <label>Bot token <span class="ax-hint">(from <a href="https://t.me/BotFather" target="_blank">@BotFather</a>)</span></label>
          <input name="telegramBotToken" placeholder="123456:ABCdef..." />
        </div>
        <div class="ax-field">
          <label>Bot username <span class="ax-hint">(optional — e.g. <code>my_support_bot</code>)</span></label>
          <input name="telegramBotUsername" placeholder="my_support_bot" />
        </div>
      </div>
    </section>

    <section class="ax-step">
      <div class="ax-step__head"><span class="ax-step__num">4</span>Anthropic API key</div>
      <div class="ax-field">
        <label>API key <span class="ax-hint">(optional — skip if you're using Claude Code)</span></label>
        <input name="anthropicApiKey" type="password" placeholder="sk-ant-…" autocomplete="off" />
      </div>
      <div class="ax-hint-block">
        The key is written to <code>.env</code> as <code>ANTHROPIC_API_KEY</code>. AgentX never transmits it — everything stays on this machine.
      </div>
    </section>

    <footer class="ax-actions">
      <button type="submit" class="ax-btn ax-btn--primary" id="submitBtn">Save and continue</button>
      <button type="button" class="ax-btn" onclick="window.location.href='/live'">Skip, I'll do it later</button>
    </footer>
  </form>
</main>
${TOPBAR_SCRIPT}
<script>
document.getElementById('enableTelegram').addEventListener('change', (e) => {
  document.getElementById('telegramFields').classList.toggle('is-show', e.target.checked);
});
document.getElementById('wizard').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = document.getElementById('msg');
  const btn = document.getElementById('submitBtn');
  msg.className = 'ax-msg'; msg.style.display = 'none';
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
      msg.className = 'ax-msg is-err'; msg.textContent = 'Bot token is required when Telegram is enabled.';
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
    msg.className = 'ax-msg is-ok';
    msg.innerHTML = '<b>' + data.summary + '</b><ol class="ax-next-steps">' + steps + '</ol>';
    btn.textContent = 'Done';
    btn.disabled = true;
  } catch (err) {
    msg.className = 'ax-msg is-err'; msg.textContent = err.message;
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
