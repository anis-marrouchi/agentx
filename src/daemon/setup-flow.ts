import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "fs"
import { homedir, hostname } from "os"
import { join, resolve } from "path"
import { modelReadiness } from "./model-ready"
import { runWizard } from "./setup-wizard"
import { mutateAgentxConfig } from "./config-mutate"
import { readDotenv, setDotenvKey } from "@/utils/dotenv"
import { existingConfigPath, pickAgent } from "@/commands/start-plan"
import { HUB_PATH } from "./ui/hub-name"

// --- The guided first run: model account → first agent → first answer (#2143) ---
//
// New-user feedback 2026-11-23: setting AgentX up was not obvious, so the
// person reached for another coding agent to edit the config. The /setup
// page now walks one path to a first answer, and this module holds its
// decisions: which model account this computer has, the first agent
// (created once; a second run finds it), and a plain sentence for each
// failure. It reads and writes only through the config and .env writers
// AgentX already has, so nobody edits a file by hand. The HTTP side is
// setup-flow-api.ts.

/** How an agent reaches its model. "api-key" is the built-in engine on the
 *  Anthropic API (orchestrator + providers.claude), as `agentx start` uses. */
export type SetupEngine = "claude-code" | "codex-cli" | "api-key" | "other"

/** Step 1 of the wizard: is a model account connected, and if not, what to do. */
export interface ModelCheck {
  ready: boolean
  engine?: SetupEngine
  /** One sentence for the person: what was found, or what is missing. */
  message: string
  /** The one command to run in Terminal, when that is the fix. */
  command?: string
  /** Offer a key field that saves to this .env variable. */
  keyVar?: string
  /** The agent's own engine is not ready, but this account is: offer to switch. */
  switchTo?: SetupEngine
}

export interface SetupEnv {
  /** The folder with agentx.json and .env. */
  dir: string
  env: Record<string, string | undefined>
  hasBinary: (bin: string) => boolean
  cliLoggedIn: (bin: string) => boolean | null
}

/** A failure the wizard shows as it is: a plain sentence and an HTTP status. */
export class SetupError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export const CLAUDE_INSTALL = "npm install -g @anthropic-ai/claude-code && claude"
const CLI_FIX: Record<string, { name: string; install: string; login: string }> = {
  claude: { name: "Claude Code", install: CLAUDE_INSTALL, login: "claude" },
  codex: { name: "Codex CLI", install: "npm install -g @openai/codex && codex login", login: "codex login" },
  opencode: { name: "OpenCode", install: "npm install -g opencode-ai && opencode auth login", login: "opencode auth login" },
}
const KEY_VAR = "ANTHROPIC_API_KEY"

/** The raw config (before ${VAR} expansion), or {} when there is none. */
export function readRawConfig(dir: string): any {
  const p = existingConfigPath(dir)
  return p ? JSON.parse(readFileSync(p, "utf-8")) : {}
}

/** The agent the wizard is about: node.defaultAgent, else the first one. */
export function firstAgent(dir: string): { id: string; name: string; workspace: string; engine: SetupEngine } | null {
  const raw = readRawConfig(dir)
  const id = pickAgent(raw)
  if (!id) return null
  const a = raw.agents[id] || {}
  return { id, name: String(a.name || id), workspace: String(a.workspace || ""), engine: engineOf(a) }
}

function engineOf(agent: any): SetupEngine {
  if (agent?.tier === "claude-code" || agent?.tier === "codex-cli") return agent.tier
  if ((agent?.tier === "orchestrator" || agent?.tier === "sdk") && agent?.provider === "claude") return "api-key"
  return "other"
}

function hasKey(e: SetupEnv, name: string): boolean {
  return Boolean(e.env[name] || readDotenv(resolve(e.dir, ".env"))[name])
}

/** The model account this computer has, before any agent exists. Claude
 *  Code first (a subscription, no key), then a saved key, then Codex. */
export function detectAccount(e: SetupEnv): ModelCheck {
  const claude = e.hasBinary("claude")
  const signedIn = claude ? e.cliLoggedIn("claude") : null
  if (claude && signedIn !== false) return { ready: true, engine: "claude-code", message: "Claude Code is installed and signed in." }
  if (hasKey(e, KEY_VAR)) return { ready: true, engine: "api-key", message: "An Anthropic API key is saved on this computer." }
  if (e.hasBinary("codex")) return { ready: true, engine: "codex-cli", message: "Codex CLI is installed." }
  if (claude) {
    return { ready: false, message: "Claude Code is installed but not signed in. Run the command below in Terminal and sign in, or paste an Anthropic API key.", command: "claude", keyVar: KEY_VAR }
  }
  return { ready: false, message: "No AI model account was found on this computer. Install Claude Code with the command below and sign in, or paste an Anthropic API key.", command: CLAUDE_INSTALL, keyVar: KEY_VAR }
}

/** Step 1: the first agent's own model when it exists, else the computer's. */
export function checkModel(e: SetupEnv): ModelCheck {
  const raw = readRawConfig(e.dir)
  const id = pickAgent(raw)
  if (!id) return detectAccount(e)
  const engine = engineOf(raw.agents[id])
  const r = modelReadiness({
    rawConfig: raw, agentId: id, env: e.env, dotenv: readDotenv(resolve(e.dir, ".env")), hasBinary: e.hasBinary, cliLoggedIn: e.cliLoggedIn,
  })
  if (r.ready) return { ready: true, engine, message: "Your agent's model account is connected." }
  const other = detectAccount(e)
  const switchTo = other.ready && other.engine !== engine ? other.engine : undefined
  if (r.need === "key") {
    return { ready: false, engine, keyVar: r.envVar, switchTo, message: "Your agent uses an API key, and none is saved yet. Paste one below; it stays in .env on this computer." }
  }
  if (r.need === "cli" && r.cli) {
    const fix = CLI_FIX[r.cli] || { name: r.cli, install: r.cli, login: r.cli }
    return e.hasBinary(r.cli)
      ? { ready: false, engine, switchTo, command: fix.login, message: `${fix.name} is installed but not signed in. Run the command below in Terminal and sign in, then press Check again.` }
      : { ready: false, engine, switchTo, command: fix.install, message: `${fix.name} is not installed on this computer. Run the command below in Terminal, then press Check again.` }
  }
  return { ready: false, engine, switchTo, message: r.hint || "Your agent has no model account yet." }
}

/** Save a pasted key to .env through the .env writer (replacing an older one). */
export function saveModelKey(e: SetupEnv, envVar: string, key: string): void {
  const k = String(key || "").trim()
  if (!k) throw new SetupError(400, "Paste your API key first.")
  if (/\s/.test(k) || k.length > 500) throw new SetupError(400, "That does not look like an API key: it is one line with no spaces.")
  if (envVar === KEY_VAR && !k.startsWith("sk-ant-")) throw new SetupError(400, "That does not look like an Anthropic API key: those start with sk-ant-. Copy it again from console.anthropic.com.")
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envVar)) throw new SetupError(400, "Unknown key name.")
  try { setDotenvKey(resolve(e.dir, ".env"), envVar, k) } catch {
    throw new SetupError(500, `AgentX could not write the .env file in ${e.dir}. Check that this folder is yours and not read-only.`)
  }
}

/** Point the first agent at another account that is ready (step 1's offer). */
export function switchEngine(dir: string, engine: SetupEngine): void {
  const configPath = existingConfigPath(dir)
  const id = pickAgent(readRawConfig(dir))
  if (!configPath || !id) throw new SetupError(409, "There is no agent yet. Create it in step 2.")
  if (engine === "other") throw new SetupError(400, "Unknown engine.")
  mutateAgentxConfig((cfg) => {
    const a = cfg.agents[id]
    Object.assign(a, engineBlock(engine))
    if (engine !== "api-key") delete a.provider
    if (engine === "api-key") {
      cfg.providers = cfg.providers || {}
      cfg.providers.claude = cfg.providers.claude || { apiKey: "${" + KEY_VAR + "}" }
    }
    return `agent "${id}" now uses ${engine}`
  }, { configPath })
}

function engineBlock(engine: SetupEngine): { tier: "claude-code" | "codex-cli" | "orchestrator"; provider?: string } {
  if (engine === "claude-code" || engine === "codex-cli") return { tier: engine }
  return { tier: "orchestrator", provider: "claude" }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
}

/** A folder the person typed: ~ is their home, a relative path is under dir. */
export function workspacePath(dir: string, typed: string | undefined, id: string): string {
  const t = String(typed || "").trim()
  if (!t) return resolve(dir, "agents", id)
  if (t === "~" || t.startsWith("~/")) return join(homedir(), t.slice(1))
  return resolve(dir, t)
}

/** Make the folder, or say in one sentence why it can't be used. */
export function ensureWritable(folder: string): void {
  if (existsSync(folder) && !statSync(folder).isDirectory()) {
    throw new SetupError(400, `${folder} is a file, not a folder. Choose another folder, or leave the field empty for the default.`)
  }
  try {
    mkdirSync(folder, { recursive: true })
    accessSync(folder, constants.W_OK)
  } catch {
    throw new SetupError(400, `AgentX can't write to the folder ${folder}. Choose a folder inside your home folder, or leave the field empty for the default.`)
  }
}

/** Step 2: create the first agent, once. With an agent already there it is
 *  returned as it is (created: false), so running the wizard again never
 *  makes a second one. */
export function createFirstAgent(e: SetupEnv, input: { name?: string; workspace?: string }, ports: { daemonPort?: number; dashboardPort?: number } = {}) {
  const existing = firstAgent(e.dir)
  if (existing) return { created: false, agent: existing }
  const account = detectAccount(e)
  if (!account.ready) throw new SetupError(409, "Connect a model account first (step 1), then create the agent.")
  const name = String(input.name || "").trim() || "Assistant"
  if (name.length > 60) throw new SetupError(400, "Keep the agent's name under 60 characters.")
  const id = slug(name) || "assistant"
  const workspace = workspacePath(e.dir, input.workspace, id)
  ensureWritable(workspace)
  runWizard({
    nodeName: hostname().replace(/\.local$/, "") || "My team",
    agent: { id, name, triggerWords: `@${id}, ${id}`, workspace, ...engineBlock(account.engine!) },
  }, e.dir, ports)
  return { created: true, agent: firstAgent(e.dir)! }
}

/** Whether the dashboard should send this visit to /setup: no agent yet.
 *  "/" always did (#1180). The Hub does too, for a person opening it in a
 *  browser (a page navigation); a script reading it gets the page. */
export function setupRedirect(path: string, state: { configExists: boolean; agentCount: number }, headers: Record<string, string | string[] | undefined>): string | null {
  if (state.configExists && state.agentCount > 0) return null
  if (path === "/") return "/setup"
  if (path !== HUB_PATH) return null
  const mode = String(headers["sec-fetch-mode"] || "")
  const accept = String(headers["accept"] || "")
  return mode === "navigate" || accept.includes("text/html") ? "/setup" : null
}

/** A failure from the daemon or the model, as one plain sentence with the
 *  next step. Never a stack trace: only the first line of an unknown error. */
export function plainError(raw: unknown): string {
  const s = String((raw as any)?.message ?? raw ?? "").trim()
  if (/ENOENT.*\b(claude|codex|opencode)\b|\b(claude|codex|opencode)\b.*(not found|ENOENT)|spawn (claude|codex|opencode)/i.test(s)) {
    return `The agent's model program is not installed. In Terminal, run: ${CLAUDE_INSTALL} — then press Try again.`
  }
  if (/credit balance/i.test(s)) return "Your API account has no credits left. Add credits at console.anthropic.com, then press Try again."
  if (/not logged in|please run \/login|log ?in again|invalid.{0,20}(api key|x-api-key)|authentication_error|\b401\b|unauthori[sz]ed/i.test(s)) {
    return "The model account refused the request: it is not signed in, or the key is wrong. Go back to step 1 and connect it again."
  }
  if (/ECONNREFUSED|fetch failed|could not reach|socket hang up|did not answer/i.test(s)) {
    return "AgentX's background service is not running. Press Try again to start it, or run agentx start in Terminal."
  }
  if (/no agent "/i.test(s)) return "The background service has not loaded your agent yet. Wait a few seconds, then press Try again."
  if (/requires SQLite/i.test(s)) return "AgentX could not open its local database. In Terminal, run: npm install -g agentix-cli — then run agentx start again."
  if (/EADDRINUSE/i.test(s)) return "The port AgentX uses is taken by another program. Close it, or in a new folder run: agentx start --port 18810 --dashboard-port 4212"
  const first = s.split("\n").map((l) => l.trim()).find((l) => l && !/^at\s/.test(l)) || "unknown error"
  return `The agent could not answer: ${first.slice(0, 200)}. Press Try again; if it keeps failing, run agentx start in Terminal.`
}
