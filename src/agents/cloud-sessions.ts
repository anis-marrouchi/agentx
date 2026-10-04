import { execFileSync, spawn as nodeSpawn, type ChildProcess } from "child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"

// --- Claude cloud sessions (#622) ---
//
// An agent can run a GitHub coding task as a Claude cloud session instead of
// a local `claude -p` run. The cloud session works on a clone of the
// repository in a remote VM, draws on the account's cloud session credit,
// and delivers its result as a pull request — not as a text reply.
//
// Off by default. Both the agent (`agents.<id>.cloudSessions.enabled`) and
// the channel (`channels.github.cloudSessions`) must opt in. Only tasks that
// arrive from the GitHub channel for an issue or pull request of a repository
// this node has a checkout of are sent to the cloud; everything else runs
// locally as before. A launch that fails falls back to a local run and logs
// the reason. While a cloud session is open for an issue, no local run
// starts for that issue: follow-up comments are forwarded to the session.
//
// `claude --cloud` needs a TTY (it prints the new session's id and URL, then
// exits), so it is spawned through a small python `pty.spawn` wrapper.
// `script(1)` fails with tcgetattr on some systems; python's pty module is on
// every macOS and nearly every Linux install.

/** Per-agent settings, `agents.<id>.cloudSessions` (daemon/config.ts). */
export interface CloudSessionsAgentSettings {
  enabled: boolean
  /** Launches per calendar day across the agent's repositories; 0 = no cap. */
  maxPerDay: number
  /** How long a launched session counts as open, blocking local runs for its issue. */
  openHours: number
  /** How long `claude --cloud` may take to print the session before the launch is given up. */
  launchTimeoutSeconds: number
}

export const CLOUD_SESSIONS_DEFAULTS: CloudSessionsAgentSettings = {
  enabled: false,
  maxPerDay: 0,
  openHours: 24,
  launchTimeoutSeconds: 120,
}

/** A session this node launched, kept until it is no longer open. */
export interface OpenCloudSession {
  /** "owner/repo" as GitHub spells it. */
  repo: string
  /** Issue or pull request number. */
  number: number
  kind: "issue" | "pull"
  sessionId: string
  url: string
  agentId: string
  /** Epoch ms of the launch. */
  startedAt: number
  /** The checkout the session was launched from; follow-ups run there too. */
  cwd?: string
  /** Epoch ms of the last follow-up forwarded to it. */
  lastMessageAt?: number
  /** Trace id of the run that launched it (task_traces.task_id). */
  traceId?: string
}

// --- GitHub repository detection ---

/** "owner/repo" from a git remote URL on github.com, or undefined for any
 *  other host or shape. Accepts https://, ssh://, git@ and bare host forms. */
export function parseGitHubRemote(url: string | undefined): string | undefined {
  if (!url) return undefined
  const trimmed = url.trim()
  const m = trimmed.match(/^(?:(?:https?|ssh|git)(?::\/\/)(?:[^@\/]+@)?|git@|)(?:www\.)?github\.com[\/:]([^\/\s]+)\/([^\/\s]+?)(?:\.git)?\/?$/i)
  if (!m) return undefined
  return `${m[1]}/${m[2]}`
}

/** The `origin` remote of a git checkout, or undefined when the directory is
 *  not one (or git is missing). Synchronous: one git call, milliseconds. */
export function originRemoteOf(dir: string): string | undefined {
  try {
    if (!dir || !existsSync(dir)) return undefined
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    }).trim() || undefined
  } catch {
    return undefined
  }
}

/** The GitHub repository and issue a channel chat id names:
 *  "owner/repo:issue:123" or "owner/repo:pull:456" (channels/github.ts). */
export function parseGitHubChatId(chatId: string | undefined): { repo: string; kind: "issue" | "pull"; number: number } | undefined {
  if (!chatId) return undefined
  const parts = chatId.split(":")
  if (parts.length < 3) return undefined
  const number = Number(parts[parts.length - 1])
  const kind = parts[parts.length - 2]
  const repo = parts.slice(0, -2).join(":")
  if (!Number.isInteger(number) || number <= 0) return undefined
  if (kind !== "issue" && kind !== "pull") return undefined
  if (!/^[^\/\s]+\/[^\/\s]+$/.test(repo)) return undefined
  return { repo, kind, number }
}

// --- Routing decision ---

export interface CloudRouteInput {
  agent: {
    tier: string
    workspace: string
    cloudSessions?: Partial<CloudSessionsAgentSettings>
  }
  /** `channels.<channel>.cloudSessions` for the task's channel. */
  channelEnabled: boolean
  context?: { channel?: string; chatId?: string; runbookPath?: string }
  /** The origin remote of a directory; injected so the decision is testable. */
  remoteOf?: (dir: string) => string | undefined
  /** A session already open for this issue, when the store has one. */
  openSession?: OpenCloudSession
  /** Launches this agent made today, for the daily cap. */
  launchesToday?: number
}

export type CloudRoute =
  | { route: "cloud"; repo: string; kind: "issue" | "pull"; number: number; cwd: string }
  | { route: "follow-up"; session: OpenCloudSession }
  | { route: "local"; reason: string }

/** Where a task runs. Pure apart from `remoteOf`; every "local" answer
 *  carries the reason, which the registry logs and records on the trace. */
export function decideCloudRoute(input: CloudRouteInput): CloudRoute {
  const settings = { ...CLOUD_SESSIONS_DEFAULTS, ...(input.agent.cloudSessions ?? {}) }
  if (!settings.enabled) return { route: "local", reason: "cloud sessions are off for this agent" }
  const channel = input.context?.channel
  if (channel !== "github") return { route: "local", reason: `channel "${channel || "api"}" does not send tasks to the cloud (GitHub only)` }
  if (!input.channelEnabled) return { route: "local", reason: "cloud sessions are off for the github channel" }
  if (input.agent.tier !== "claude-code") return { route: "local", reason: `agent tier "${input.agent.tier}" cannot run cloud sessions (claude-code only)` }
  const target = parseGitHubChatId(input.context?.chatId)
  if (!target) return { route: "local", reason: `task is not for a GitHub issue or pull request (chat "${input.context?.chatId || ""}")` }
  if (input.openSession) return { route: "follow-up", session: input.openSession }
  if (settings.maxPerDay > 0 && (input.launchesToday ?? 0) >= settings.maxPerDay) {
    return { route: "local", reason: `daily cap of ${settings.maxPerDay} cloud launches reached` }
  }
  const remoteOf = input.remoteOf ?? originRemoteOf
  const candidates = [input.context?.runbookPath, input.agent.workspace].filter((d): d is string => !!d)
  const wanted = target.repo.toLowerCase()
  for (const dir of candidates) {
    const repo = parseGitHubRemote(remoteOf(dir))
    if (repo && repo.toLowerCase() === wanted) return { route: "cloud", repo: target.repo, kind: target.kind, number: target.number, cwd: dir }
  }
  return { route: "local", reason: `no checkout of ${target.repo} on this node (looked in ${candidates.join(", ") || "nothing"}); set the project rule's runbook path to a clone whose origin is github.com/${target.repo}` }
}

// --- Open-session store ---

const DAY_MS = 24 * 60 * 60 * 1000
/** Entries older than this are dropped on load. Keeps daily counts whole. */
const KEEP_MS = 7 * DAY_MS

/** Sessions this node launched, in a small JSON file (default
 *  .agentx/cloud-sessions.json). Survives a daemon restart, so an open
 *  session still blocks a local run after one. */
export class CloudSessionStore {
  private sessions: OpenCloudSession[] = []
  private loaded = false

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"))
      const list = Array.isArray(raw?.sessions) ? raw.sessions : []
      this.sessions = list.filter((s: any) => s && typeof s.repo === "string" && typeof s.sessionId === "string" && Number.isFinite(s.startedAt))
    } catch {
      this.sessions = []
    }
  }

  private save(): void {
    const now = Date.now()
    this.sessions = this.sessions.filter((s) => now - s.startedAt < KEEP_MS)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ sessions: this.sessions }, null, 2))
      renameSync(tmp, this.file)
    } catch { /* best effort: the daemon keeps the in-memory copy */ }
  }

  /** The open session for an issue, if one was launched less than
   *  `openHours` ago. */
  open(repo: string, number: number, openHours: number, now = Date.now()): OpenCloudSession | undefined {
    this.load()
    const key = repo.toLowerCase()
    return this.sessions.find((s) => s.repo.toLowerCase() === key && s.number === number && now - s.startedAt < openHours * 60 * 60 * 1000)
  }

  record(session: OpenCloudSession): void {
    this.load()
    this.sessions = this.sessions.filter((s) => !(s.repo.toLowerCase() === session.repo.toLowerCase() && s.number === session.number))
    this.sessions.push(session)
    this.save()
  }

  /** Note a follow-up forwarded to the session. */
  touch(sessionId: string, now = Date.now()): void {
    this.load()
    const s = this.sessions.find((x) => x.sessionId === sessionId)
    if (!s) return
    s.lastMessageAt = now
    this.save()
  }

  /** Forget the session for an issue, so the next task runs normally. */
  close(repo: string, number: number): boolean {
    this.load()
    const before = this.sessions.length
    this.sessions = this.sessions.filter((s) => !(s.repo.toLowerCase() === repo.toLowerCase() && s.number === number))
    if (this.sessions.length === before) return false
    this.save()
    return true
  }

  /** Launches by an agent since local midnight. */
  launchesToday(agentId: string, now = Date.now()): number {
    this.load()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return this.sessions.filter((s) => s.agentId === agentId && s.startedAt >= start.getTime() && s.startedAt <= now).length
  }

  all(): OpenCloudSession[] {
    this.load()
    return [...this.sessions]
  }
}

// --- Launch through a pty ---

/** Runs argv under a pseudo-terminal and exits with the child's status. */
export const PTY_WRAPPER = [
  "import os, pty, sys",
  "status = pty.spawn(sys.argv[1:])",
  "sys.exit(os.waitstatus_to_exitcode(status) if isinstance(status, int) else 0)",
].join("\n")

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess

export interface CloudLaunchOptions {
  cwd: string
  prompt: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  /** Forward `prompt` to this open session instead of creating one. */
  sessionId?: string
  spawn?: SpawnFn
  python?: string
}

export type CloudLaunchResult =
  | { ok: true; sessionId: string; url: string; output: string }
  | { ok: false; reason: string; output: string }

/** The `claude` command line for a launch or a follow-up. */
export function cloudClaudeArgs(prompt: string, sessionId?: string): string[] {
  return sessionId ? ["-p", prompt, "--cloud", sessionId] : ["--cloud", prompt]
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\r/g

export function stripTerminalCodes(text: string): string {
  return text.replace(ANSI_RE, "")
}

/** The session id and URL `claude --cloud` printed. The id is taken from
 *  the URL's last segment when it is not printed on its own. */
export function parseCloudLaunchOutput(raw: string): { sessionId?: string; url?: string } {
  const text = stripTerminalCodes(raw)
  const url = text.match(/https:\/\/claude\.ai\/code\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+)*/)?.[0]
  let sessionId = text.match(/\bsession_[A-Za-z0-9]{6,}\b/)?.[0]
  if (!sessionId && url) {
    const last = url.split("/").filter(Boolean).pop()
    if (last && last !== "code") sessionId = last
  }
  return { sessionId, url }
}

/** Starts a cloud session (or forwards a follow-up to one) and returns its
 *  id and URL. Never throws: every failure is a `reason` for the fallback. */
export async function launchCloudSession(opts: CloudLaunchOptions): Promise<CloudLaunchResult> {
  const spawn: SpawnFn = opts.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, o))
  const python = opts.python ?? "python3"
  const args = ["-c", PTY_WRAPPER, "claude", ...cloudClaudeArgs(opts.prompt, opts.sessionId)]
  const env: NodeJS.ProcessEnv = { ...opts.env, NO_COLOR: "1", FORCE_COLOR: "0" }
  let output = ""
  const append = (chunk: Buffer | string) => {
    output += chunk.toString()
    if (output.length > 64_000) output = output.slice(-64_000)
  }
  const tail = () => stripTerminalCodes(output).trim().split("\n").slice(-5).join("\n").slice(-600)

  return new Promise<CloudLaunchResult>((resolve) => {
    let settled = false
    const done = (result: CloudLaunchResult) => { if (!settled) { settled = true; resolve(result) } }
    let proc: ChildProcess
    try {
      proc = spawn(python, args, { cwd: opts.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch (e: any) {
      done({ ok: false, reason: `could not start ${python}: ${e?.message || e}`, output })
      return
    }
    const killTree = (signal: NodeJS.Signals) => {
      try { if (proc.pid) process.kill(-proc.pid, signal) } catch { try { proc.kill(signal) } catch { /* gone */ } }
    }
    const timer = setTimeout(() => {
      killTree("SIGTERM")
      setTimeout(() => killTree("SIGKILL"), 3_000).unref?.()
      done({ ok: false, reason: `claude --cloud did not print a session within ${Math.round(opts.timeoutMs / 1000)}s${tail() ? `; last output: ${tail()}` : ""}`, output })
    }, opts.timeoutMs)
    timer.unref?.()
    proc.stdout?.on("data", append)
    proc.stderr?.on("data", append)
    proc.on("error", (e: any) => {
      clearTimeout(timer)
      const missing = e?.code === "ENOENT"
      done({ ok: false, reason: missing ? `${python} is not installed (needed to give claude --cloud a terminal)` : `launch failed: ${e?.message || e}`, output })
    })
    proc.on("close", (code) => {
      clearTimeout(timer)
      if (settled) return
      const parsed = parseCloudLaunchOutput(output)
      if (opts.sessionId) {
        if (code === 0) { done({ ok: true, sessionId: opts.sessionId, url: parsed.url || "", output }); return }
        done({ ok: false, reason: `claude -p --cloud exited with code ${code ?? "unknown"}${tail() ? `: ${tail()}` : ""}`, output })
        return
      }
      if (parsed.sessionId && parsed.url) { done({ ok: true, sessionId: parsed.sessionId, url: parsed.url, output }); return }
      if (code !== 0) { done({ ok: false, reason: `claude --cloud exited with code ${code ?? "unknown"}${tail() ? `: ${tail()}` : ""}`, output }); return }
      done({ ok: false, reason: `claude --cloud printed no session id or URL${tail() ? `; last output: ${tail()}` : ""}`, output })
    })
  })
}

// --- Prompt and reply text ---

/** Linux caps one argv string at 128 KiB; stay well under it. */
const MAX_CLOUD_PROMPT_CHARS = 100_000

/** What the cloud session is asked to do. The session reads the repository's
 *  own CLAUDE.md; the agent's local system prompt is not sent. */
export function buildCloudPrompt(message: string, target: { repo: string; kind: "issue" | "pull"; number: number }): string {
  const what = target.kind === "pull" ? "pull request" : "issue"
  const footer = `\n\n---\nThis task comes from GitHub ${what} #${target.number} in ${target.repo}. Work in this repository and open or update a pull request that references #${target.number}.`
  const room = MAX_CLOUD_PROMPT_CHARS - footer.length
  const body = message.length > room ? `${message.slice(0, room)}\n[message cut at ${room} characters]` : message
  return `${body}${footer}`
}

export function cloudSessionReply(session: { sessionId: string; url: string }, kind: "issue" | "pull", openHours: number): string {
  const what = kind === "pull" ? "pull request" : "issue"
  return [
    `Started a Claude cloud session for this ${what}. The result arrives as a pull request.`,
    `Session: \`${session.sessionId}\``,
    session.url,
    `Comments here are forwarded to that session for the next ${openHours} hours.`,
  ].join("\n")
}

export function cloudFollowUpReply(session: { sessionId: string; url: string }): string {
  return `Forwarded to the open Claude cloud session \`${session.sessionId}\` (${session.url}).`
}

// --- Orchestration: cloud first, local on failure ---

export interface CloudDispatchResult {
  content: string
  error?: string
  cloudSession: { id: string; url: string; followUp?: boolean }
}

export interface CloudDispatchDeps {
  route: CloudRoute
  agentId: string
  message: string
  settings: CloudSessionsAgentSettings
  store: Pick<CloudSessionStore, "record" | "touch">
  launch: (opts: { cwd: string; prompt: string; sessionId?: string }) => Promise<CloudLaunchResult>
  log: (line: string) => void
  /** Recorded on the task trace (task:step "cloud_session"). */
  trace: (step: { action: "launched" | "follow-up" | "fallback" | "skipped"; status: "ok" | "error"; summary: string }) => void
  traceId?: string
  now?: () => number
}

/** Runs the task in the cloud when the route says so. Returns null when the
 *  task must run locally: the route said so, or the launch failed (logged and
 *  traced with the reason). A follow-up that cannot be forwarded is an error
 *  response, never a local run: the session stays the one working on the issue. */
export async function dispatchCloudSession(deps: CloudDispatchDeps): Promise<CloudDispatchResult | null> {
  const { route } = deps
  const now = deps.now ?? Date.now
  if (route.route === "local") {
    deps.trace({ action: "skipped", status: "ok", summary: route.reason })
    return null
  }
  if (route.route === "follow-up") {
    const s = route.session
    const result = await deps.launch({ cwd: s.cwd || process.cwd(), prompt: deps.message, sessionId: s.sessionId })
    if (result.ok) {
      deps.store.touch(s.sessionId, now())
      deps.log(`[${deps.agentId}] forwarded to open cloud session ${s.sessionId} for ${s.repo}#${s.number}`)
      deps.trace({ action: "follow-up", status: "ok", summary: JSON.stringify({ sessionId: s.sessionId, url: s.url }) })
      return { content: cloudFollowUpReply(s), cloudSession: { id: s.sessionId, url: s.url, followUp: true } }
    }
    deps.log(`[${deps.agentId}] forwarding to cloud session ${s.sessionId} failed: ${result.reason}`)
    deps.trace({ action: "follow-up", status: "error", summary: result.reason })
    return {
      content: "",
      error: `Claude cloud session \`${s.sessionId}\` is still open for this ${s.kind === "pull" ? "pull request" : "issue"} (${s.url}); forwarding this comment to it failed: ${result.reason}. No local run starts while the session is open.`,
      cloudSession: { id: s.sessionId, url: s.url, followUp: true },
    }
  }
  const prompt = buildCloudPrompt(deps.message, route)
  const result = await deps.launch({ cwd: route.cwd, prompt })
  if (!result.ok) {
    deps.log(`[${deps.agentId}] cloud session launch for ${route.repo}#${route.number} failed, running locally: ${result.reason}`)
    deps.trace({ action: "fallback", status: "error", summary: result.reason })
    return null
  }
  const session: OpenCloudSession = {
    repo: route.repo, number: route.number, kind: route.kind,
    sessionId: result.sessionId, url: result.url, agentId: deps.agentId,
    startedAt: now(), cwd: route.cwd, traceId: deps.traceId,
  }
  deps.store.record(session)
  deps.log(`[${deps.agentId}] cloud session ${result.sessionId} started for ${route.repo}#${route.number}: ${result.url}`)
  deps.trace({ action: "launched", status: "ok", summary: JSON.stringify({ sessionId: result.sessionId, url: result.url, repo: route.repo, number: route.number }) })
  return { content: cloudSessionReply(session, route.kind, deps.settings.openHours), cloudSession: { id: result.sessionId, url: result.url } }
}
