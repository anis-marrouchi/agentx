// CLI account profiles (#2101 P9b): more than one Claude Code or Codex
// account on one machine, and a switch for which one new runs use.
//
// Each CLI keeps its sign-in in its own config directory: Claude Code in
// CLAUDE_CONFIG_DIR (default ~/.claude), Codex in CODEX_HOME (default
// ~/.codex). A profile is a name and such a directory. The owner signs in
// once per directory with the CLI itself (`CLAUDE_CONFIG_DIR=… claude`,
// `CODEX_HOME=… codex login`); AgentX never reads, copies or stores a token.
//
// The active profile is set on the environment of each CLI process AgentX
// starts from then on (buildAgentEnv, the persistent Claude factory). A
// process already running keeps the account it started with. An agent whose
// workspace .env sets the variable itself keeps its own value.
//
// State: ~/.agentx/cli-accounts.json, written only by the Hub's owner API.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type CliProvider = "claude" | "codex"

/** Each provider's config-directory variable and its default directory. */
export const CLI_PROVIDERS: Record<CliProvider, { label: string; envVar: string; defaultDir: (home: string) => string; signIn: string }> = {
  claude: { label: "Claude Code", envVar: "CLAUDE_CONFIG_DIR", defaultDir: (h) => join(h, ".claude"), signIn: "CLAUDE_CONFIG_DIR=<dir> claude, then /login" },
  codex: { label: "Codex", envVar: "CODEX_HOME", defaultDir: (h) => join(h, ".codex"), signIn: "CODEX_HOME=<dir> codex login" },
}

export interface CliProfile { name: string; dir: string }
export interface CliProviderState { profiles: CliProfile[]; active: string }
export type CliAccounts = Partial<Record<CliProvider, CliProviderState>>

export const CLI_ACCOUNTS_FILE = join(homedir(), ".agentx", "cli-accounts.json")

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i
/** "default" is the CLI's own directory: always there, never stored. */
export const DEFAULT_PROFILE = "default"

function isProvider(p: unknown): p is CliProvider {
  return typeof p === "string" && Object.prototype.hasOwnProperty.call(CLI_PROVIDERS, p)
}

/** The file's state, cleaned: unknown providers, bad names and relative dirs dropped. */
export function readCliAccounts(file = CLI_ACCOUNTS_FILE): CliAccounts {
  let raw: any
  try { raw = JSON.parse(readFileSync(file, "utf-8")) } catch { return {} }
  const out: CliAccounts = {}
  for (const [p, v] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    if (!isProvider(p) || !v || typeof v !== "object") continue
    const profiles = (Array.isArray((v as any).profiles) ? (v as any).profiles : [])
      .filter((x: any) => x && typeof x.name === "string" && NAME_RE.test(x.name) && x.name !== DEFAULT_PROFILE && typeof x.dir === "string" && isAbsolute(x.dir))
      .map((x: any) => ({ name: x.name, dir: x.dir }))
    const active = typeof (v as any).active === "string" && profiles.some((x: CliProfile) => x.name === (v as any).active) ? (v as any).active : DEFAULT_PROFILE
    out[p] = { profiles, active }
  }
  return out
}

function writeCliAccounts(state: CliAccounts, file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Set the active profile's directory on a CLI process's environment, for
 * each provider with a profile other than default. `own` lists the keys the
 * agent's workspace .env set: those win.
 */
export function withCliAccountEnv(env: NodeJS.ProcessEnv, own: Iterable<string> = [], state: CliAccounts = readCliAccounts()): NodeJS.ProcessEnv {
  const mine = new Set(own)
  for (const p of Object.keys(CLI_PROVIDERS) as CliProvider[]) {
    const s = state[p]
    if (!s || s.active === DEFAULT_PROFILE) continue
    const prof = s.profiles.find((x) => x.name === s.active)
    const v = CLI_PROVIDERS[p].envVar
    if (prof && !mine.has(v)) env[v] = prof.dir
  }
  return env
}

/**
 * The config directory new runs of `provider` use: the active profile's, else
 * the variable as this process has it, else the CLI's own default. The plan
 * readers use it so they read the account the runs use (#2101 R28g).
 */
export function activeCliDir(provider: CliProvider, state: CliAccounts = readCliAccounts(), env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const s = state[provider]
  const prof = s && s.active !== DEFAULT_PROFILE ? s.profiles.find((x) => x.name === s.active) : undefined
  return prof?.dir || env[CLI_PROVIDERS[provider].envVar]?.trim() || CLI_PROVIDERS[provider].defaultDir(home)
}

/** What the Hub shows: per provider, its profiles (default first), the active one and whether each dir exists. */
export function cliAccountsView(state: CliAccounts = readCliAccounts(), home = homedir()) {
  return (Object.keys(CLI_PROVIDERS) as CliProvider[]).map((p) => {
    const s = state[p] ?? { profiles: [], active: DEFAULT_PROFILE }
    const all = [{ name: DEFAULT_PROFILE, dir: CLI_PROVIDERS[p].defaultDir(home) }, ...s.profiles]
    return {
      provider: p, label: CLI_PROVIDERS[p].label, envVar: CLI_PROVIDERS[p].envVar, signIn: CLI_PROVIDERS[p].signIn,
      active: s.active,
      profiles: all.map((x) => ({ name: x.name, dir: x.dir, exists: existsSync(x.dir) })),
    }
  })
}

/** One change from the owner: add a profile, remove one, or pick the active one. */
export function changeCliAccounts(
  body: { provider?: unknown; action?: unknown; name?: unknown; dir?: unknown },
  file = CLI_ACCOUNTS_FILE,
  home = homedir(),
): CliAccounts {
  const p = body.provider
  if (!isProvider(p)) throw Object.assign(new Error("provider must be claude or codex"), { status: 400 })
  const name = typeof body.name === "string" ? body.name.trim() : ""
  const state = readCliAccounts(file)
  const s: CliProviderState = state[p] ?? { profiles: [], active: DEFAULT_PROFILE }
  if (body.action === "use") {
    if (name !== DEFAULT_PROFILE && !s.profiles.some((x) => x.name === name)) throw Object.assign(new Error(`no ${p} profile named ${name}`), { status: 404 })
    s.active = name
  } else if (body.action === "add") {
    if (!NAME_RE.test(name) || name === DEFAULT_PROFILE) throw Object.assign(new Error("name: letters, digits, - and _, up to 40, not default"), { status: 400 })
    if (s.profiles.some((x) => x.name === name)) throw Object.assign(new Error(`a ${p} profile named ${name} exists`), { status: 409 })
    const raw = typeof body.dir === "string" ? body.dir.trim() : ""
    if (!raw) throw Object.assign(new Error("dir is required"), { status: 400 })
    const dir = resolve(raw.replace(/^~(?=$|\/)/, home))
    s.profiles.push({ name, dir })
  } else if (body.action === "remove") {
    if (!s.profiles.some((x) => x.name === name)) throw Object.assign(new Error(`no ${p} profile named ${name}`), { status: 404 })
    s.profiles = s.profiles.filter((x) => x.name !== name)
    if (s.active === name) s.active = DEFAULT_PROFILE
  } else {
    throw Object.assign(new Error("action must be use, add or remove"), { status: 400 })
  }
  state[p] = s
  writeCliAccounts(state, file)
  return state
}
