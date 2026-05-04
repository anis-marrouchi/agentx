import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs"
import { resolve } from "path"
import { hostname } from "os"
import { spawn } from "child_process"
import type { IncomingMessage, ServerResponse } from "http"
import { mutateAgentxConfig, writeAgentxConfig } from "./config-mutate"
import { renderSetupPage } from "./ui/pages/setup"
import { loadDaemonConfig } from "./config"

/** Shape of the pre-render state snapshot — exported so the page file can
 *  type its props without re-importing this whole module. */
export interface WizardState {
  configExists: boolean
  agentCount: number
  channelCount: number
  nodeName?: string
}

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
    tier: "claude-code" | "codex-cli" | "sdk"
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
export function wizardState(baseDir: string = process.cwd()): WizardState {
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
  if (payload.agent.tier !== "claude-code" && payload.agent.tier !== "codex-cli" && payload.agent.tier !== "sdk") {
    throw new Error("AI engine must be claude-code, codex-cli, or sdk.")
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
  if (payload.agent.tier === "codex-cli") {
    nextSteps.push("Run  codex --version  to confirm Codex CLI is installed (needed for the codex-cli engine)")
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
  // Field names must match telegramAccountSchema (src/daemon/config.ts):
  //   token: z.string()       — NOT "botToken"
  //   agentBinding: z.string()
  // Zod silently strips unknown keys, so writing "botToken" produced
  // configs that failed validation with `token: Required` even when the
  // operator had TG_<AGENT>_BOT_TOKEN set in .env.
  void payload.telegram?.botUsername  // collected by the form but not in the schema; intentional drop.
  return {
    token: "${" + tokenRef + "}",
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
  const defaultNode = state.nodeName || hostname().replace(/\.local$/, "")
  const html = renderSetupPage(state, defaultNode)
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

/**
 * POST /api/setup/start-daemon — fork `agentx daemon start` from the wizard's
 * success page so non-technical operators don't have to switch to a terminal.
 *
 * Spawns detached so the daemon survives the wizard process exiting, then
 * polls the daemon URL until it answers (or we hit the timeout). Returns the
 * resolved URL on success, or the underlying error + the path the operator
 * should hit manually on failure.
 */
export async function handleStartDaemonPost(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Content-Type", "application/json")
  let bind: string
  try {
    const cfg = loadDaemonConfig()
    bind = cfg.node?.bind || "127.0.0.1:18800"
  } catch (e: any) {
    res.writeHead(400)
    res.end(JSON.stringify({ ok: false, error: `Config validation failed: ${e.message}` }))
    return
  }

  const url = `http://${bind.replace(/^0\.0\.0\.0/, "127.0.0.1")}`
  // Already up? (Idempotent — clicking the button twice is harmless.)
  if (await probe(url)) {
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, url, alreadyRunning: true }))
    return
  }

  // dist/cli.js sits beside this file's compiled chunk. Use process.argv[1]
  // when available — that's the entrypoint the user invoked, which works for
  // both `agentx setup` (resolves to dist/cli.js) and `tsx src/cli.ts` in dev.
  const cli = process.argv[1] || resolve(import.meta.dirname, "cli.js")
  try {
    const child = spawn(process.execPath, [cli, "daemon", "start"], {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
    })
    child.unref()
  } catch (e: any) {
    res.writeHead(500)
    res.end(JSON.stringify({ ok: false, error: `Failed to spawn daemon: ${e.message}`, manualUrl: url }))
    return
  }

  // Poll for up to ~12s. Daemon boot covers .env load, config parse, mesh
  // discovery, and bot registration — usually under 4s on a clean install.
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, 400))
    if (await probe(url)) {
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, url, alreadyRunning: false }))
      return
    }
  }

  res.writeHead(504)
  res.end(JSON.stringify({
    ok: false,
    error: "Daemon spawn succeeded but never bound the port within 12s — check `agentx daemon status` and the dotfile log for errors.",
    manualUrl: url,
  }))
}

async function probe(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(800) })
    return r.status > 0 && r.status < 600
  } catch { return false }
}
