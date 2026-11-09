import { execFile } from "child_process"
import { forgeHeaders, type ForgeConnectors } from "@/requests/checkers/issue"
import { isoDay, type Period } from "./model"

// --- Where a number's readings come from (#1826) ---
//
//   manual     nobody reads it: the owner or an agent records each reading
//   count      issues or pull requests on GitHub or GitLab, with filters:
//              labels, state, and a date window (made, or closed, within
//              the reading's window)
//   http-json  an http(s) GET that answers JSON, and the path to the value
//              in it. `{start}` and `{end}` in the address become the
//              window's first and last day (2026-11-02)
//   command    a shell command on this machine. Only in agentx.json: an
//              agent or the CLI cannot set one up
//
// A reader returns the value, or why it could not read one. It never
// throws, and never turns a failure into 0.

export const SOURCE_KINDS = ["manual", "count", "http-json", "command"] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export type CountState = "open" | "closed" | "all"
export type CountWindow = "none" | "created" | "closed"

export interface ManualSource { kind: "manual" }
export interface CountSource {
  kind: "count"
  provider: "github" | "gitlab"
  project: string
  what: "issues" | "prs" | "all"
  /** Default open. */
  state: CountState
  /** Every label must be on the item. */
  labels: string[]
  /** none: the count now. created: made within the reading's window.
   *  closed: closed within it (GitHub only). */
  window: CountWindow
}
export interface HttpJsonSource {
  kind: "http-json"
  url: string
  /** Where the value is: `data.views`, `items[0].count`. Empty: the whole
   *  answer is the number. */
  path: string
  /** Request headers. Only from agentx.json, so a token stays out of
   *  what agents can read or write. */
  headers?: Record<string, string>
}
export interface CommandSource {
  kind: "command"
  command: string
  /** Where the value is in the output when it is JSON. Empty: the output
   *  is the number. */
  path: string
  timeoutSeconds: number
}
export type NumberSource = ManualSource | CountSource | HttpJsonSource | CommandSource

export const URL_MAX = 1000
export const PATH_MAX = 200
export const COMMAND_MAX = 2000
const PROJECT_RE = /^[\w.-]+(?:\/[\w.-]+)+$/
const LABEL_MAX = 60

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** Check a source spec. `fromConfig`: written by the owner in agentx.json,
 *  so a command and request headers are allowed. */
export function parseSource(v: unknown, fromConfig = false): NumberSource | { error: string } {
  if (v === undefined || v === null || v === "") return { kind: "manual" }
  if (typeof v !== "object" || Array.isArray(v)) return { error: `source must be an object with a kind: ${SOURCE_KINDS.join(", ")}` }
  const raw = v as Record<string, unknown>
  const kind = str(raw.kind).toLowerCase() || "manual"
  if (kind === "manual") return { kind: "manual" }
  if (kind === "count") return parseCountSource(raw)
  if (kind === "http-json") {
    const url = str(raw.url)
    if (!/^https?:\/\/\S+$/i.test(url)) return { error: "source.url must be an http(s) address" }
    if (url.length > URL_MAX) return { error: `source.url is longer than ${URL_MAX} characters` }
    const path = parsePath(raw.path)
    if (typeof path !== "string") return path
    if (raw.headers !== undefined && !fromConfig) return { error: "source.headers can only be set in agentx.json (numbers.items)" }
    const headers = raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
      ? Object.fromEntries(Object.entries(raw.headers as Record<string, unknown>).filter(([, h]) => typeof h === "string").map(([k, h]) => [k, String(h)]))
      : undefined
    return { kind: "http-json", url, path, ...(headers && Object.keys(headers).length ? { headers } : {}) }
  }
  if (kind === "command") {
    if (!fromConfig) return { error: "a command source can only be set in agentx.json (numbers.items), by the owner" }
    const command = str(raw.command)
    if (!command) return { error: "source.command is needed: the shell command that prints the number" }
    if (command.length > COMMAND_MAX) return { error: `source.command is longer than ${COMMAND_MAX} characters` }
    const path = parsePath(raw.path)
    if (typeof path !== "string") return path
    const t = raw.timeoutSeconds === undefined ? 30 : Number(raw.timeoutSeconds)
    if (!Number.isFinite(t) || t < 1 || t > 600) return { error: "source.timeoutSeconds must be 1 to 600" }
    return { kind: "command", command, path, timeoutSeconds: Math.round(t) }
  }
  return { error: `source.kind must be one of ${SOURCE_KINDS.join(", ")}` }
}

function parsePath(v: unknown): string | { error: string } {
  const path = str(v).replace(/^\$\.?/, "")
  if (path.length > PATH_MAX) return { error: `source.path is longer than ${PATH_MAX} characters` }
  if (path && !/^[\w-]+(?:\[\d+\])*(?:\.[\w-]+(?:\[\d+\])*)*$/.test(path) && !/^(?:\[\d+\])+(?:\.[\w-]+(?:\[\d+\])*)*$/.test(path)) {
    return { error: "source.path must name keys and indexes, such as data.views or items[0].count" }
  }
  return path
}

function parseCountSource(raw: Record<string, unknown>): CountSource | { error: string } {
  const provider = str(raw.provider).toLowerCase()
  if (provider !== "github" && provider !== "gitlab") return { error: "source.provider must be github or gitlab" }
  const project = str(raw.project)
  const parts = project.split("/")
  if (!PROJECT_RE.test(project) || parts.some((p) => p === "." || p === "..") || (provider === "github" && parts.length !== 2)) {
    return { error: provider === "github" ? 'source.project must be "owner/repo"' : 'source.project must be "group/project"' }
  }
  const what = (str(raw.what) || "issues").toLowerCase()
  if (what !== "issues" && what !== "prs" && what !== "all") return { error: "source.what must be issues, prs or all" }
  const state = (str(raw.state) || "open").toLowerCase()
  if (state !== "open" && state !== "closed" && state !== "all") return { error: "source.state must be open, closed or all" }
  const rawLabels = Array.isArray(raw.labels) ? raw.labels : typeof raw.labels === "string" ? raw.labels.split(",") : raw.labels === undefined ? [] : null
  if (!rawLabels) return { error: "source.labels must be a list of label names" }
  const labels = rawLabels.map(str).filter(Boolean)
  if (labels.some((l) => l.length > LABEL_MAX || /["\n]/.test(l))) return { error: `a label must be at most ${LABEL_MAX} characters, with no quotes` }
  if (labels.length > 10) return { error: "at most 10 labels" }
  const window = (str(raw.window) || "none").toLowerCase()
  if (window !== "none" && window !== "created" && window !== "closed") return { error: "source.window must be none, created or closed" }
  if (window === "closed" && provider === "gitlab") return { error: "source.window closed works on GitHub only" }
  if (window === "closed" && state === "open") return { error: "source.window closed counts closed items: set state to closed or all" }
  return { provider, project, kind: "count", what, state, labels, window }
}

/** A stored source read back. Manual when it is not one. */
export function readSource(json: string | null | undefined): NumberSource {
  if (!json) return { kind: "manual" }
  try {
    const s = parseSource(JSON.parse(json), true)
    return "error" in s ? { kind: "manual" } : s
  } catch {
    return { kind: "manual" }
  }
}

/** The source in a few words. A command is not shown, only that it is one. */
export function describeSource(s: NumberSource): string {
  switch (s.kind) {
    case "manual": return "recorded by hand"
    case "count": {
      const what = s.what === "issues" ? "issues" : s.what === "prs" ? "pull requests" : "issues and pull requests"
      const state = s.state === "all" ? "" : `${s.state} `
      const labels = s.labels.length ? ` labelled ${s.labels.join(" + ")}` : ""
      const window = s.window === "none" ? "" : ` ${s.window} in the window`
      return `${state}${what} in ${s.provider} ${s.project}${labels}${window}`
    }
    case "http-json": return `${s.url.replace(/[?#].*$/, "")}${s.path ? ` → ${s.path}` : ""}`
    case "command": return "a command on this machine"
  }
}

/** The value at `path` in parsed JSON, as a finite number. */
export function valueAt(data: unknown, path: string): number | { error: string } {
  let cur: unknown = data
  if (path) {
    for (const part of path.match(/[\w-]+|\[\d+\]/g) ?? []) {
      if (cur === null || typeof cur !== "object") return { error: `nothing at ${path}` }
      cur = part.startsWith("[") ? (cur as unknown[])[Number(part.slice(1, -1))] : (cur as Record<string, unknown>)[part]
    }
  }
  const n = typeof cur === "number" ? cur : typeof cur === "string" && cur.trim() !== "" ? Number(cur.replace(/,/g, "")) : NaN
  return Number.isFinite(n) ? n : { error: `${path || "the answer"} is not a number` }
}

export type ReadResult = { value: number } | { error: string }

export interface ReaderDeps {
  connectors: ForgeConnectors
  fetch?: typeof fetch
  /** Runs a command: its output, or why it failed. */
  run?: (command: string, env: Record<string, string>, timeoutMs: number) => Promise<{ stdout: string } | { error: string }>
  cwd?: string
}

const TIMEOUT_MS = 15_000
const BODY_MAX = 1_000_000

const fill = (url: string, p: Period) =>
  url.replace(/\{start\}/g, isoDay(p.start)).replace(/\{end\}/g, isoDay(p.end - 1))

/** Read one value for the window `period`. Never throws. */
export async function readSourceValue(source: NumberSource, period: Period, deps: ReaderDeps): Promise<ReadResult> {
  try {
    switch (source.kind) {
      case "manual": return { error: "this number is recorded by hand" }
      case "count": return await readCount(source, period, deps)
      case "http-json": return await readHttpJson(source, period, deps)
      case "command": return await readCommand(source, period, deps)
    }
  } catch (e: any) {
    return { error: `the read failed: ${String(e?.message ?? e).slice(0, 200)}` }
  }
}

/** The search or list address of one count read. */
export function countUrl(s: CountSource, kind: "issues" | "prs", period: Period, connectors: ForgeConnectors): string | { error: string } {
  const first = isoDay(period.start)
  const last = isoDay(period.end - 1)
  if (s.provider === "github") {
    const c = connectors.github
    if (!c) return { error: "no github connector on this node (channels.github or requests.checkers.github)" }
    const terms = [`repo:${s.project}`, `is:${kind === "prs" ? "pr" : "issue"}`]
    if (s.state !== "all") terms.push(`is:${s.state}`)
    for (const l of s.labels) terms.push(`label:"${l}"`)
    if (s.window !== "none") terms.push(`${s.window}:${first}..${last}`)
    return `${c.apiUrl.replace(/\/$/, "")}/search/issues?q=${encodeURIComponent(terms.join(" "))}&per_page=1`
  }
  const c = connectors.gitlab
  if (!c) return { error: "no gitlab connector on this node (channels.gitlab or requests.checkers.gitlab)" }
  const q = new URLSearchParams({ state: s.state === "open" ? "opened" : s.state, per_page: "1" })
  if (s.labels.length) q.set("labels", s.labels.join(","))
  if (s.window === "created") {
    q.set("created_after", new Date(period.start).toISOString())
    q.set("created_before", new Date(period.end).toISOString())
  }
  return `${c.url.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(s.project)}/${kind === "prs" ? "merge_requests" : "issues"}?${q}`
}

async function readCount(s: CountSource, period: Period, deps: ReaderDeps): Promise<ReadResult> {
  const doFetch = deps.fetch ?? fetch
  let total = 0
  for (const kind of s.what === "all" ? ["issues", "prs"] as const : [s.what]) {
    const url = countUrl(s, kind, period, deps.connectors)
    if (typeof url !== "string") return url
    let res: Response
    try {
      res = await doFetch(url, { headers: forgeHeaders(s.provider, deps.connectors), signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      return { error: `${s.project} could not be reached (${errorName(e)})` }
    }
    if (!res.ok) return { error: `${s.project}: ${res.status === 404 ? "not found (or not visible to the connector)" : `HTTP ${res.status}`}` }
    let n: number
    if (s.provider === "gitlab") {
      n = Number(res.headers.get("x-total"))
      if (!Number.isInteger(n) || n < 0) return { error: `${s.project}: no X-Total in the answer` }
    } else {
      const body: any = await res.json().catch(() => null)
      n = Number(body?.total_count)
      if (!Number.isInteger(n) || n < 0) return { error: `${s.project}: no total_count in the answer` }
    }
    total += n
  }
  return { value: total }
}

async function readHttpJson(s: HttpJsonSource, period: Period, deps: ReaderDeps): Promise<ReadResult> {
  const doFetch = deps.fetch ?? fetch
  const url = fill(s.url, period)
  const shown = url.replace(/[?#].*$/, "")
  let res: Response
  try {
    res = await doFetch(url, { headers: { Accept: "application/json", ...s.headers }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" })
  } catch (e) {
    return { error: `${shown} could not be reached (${errorName(e)})` }
  }
  if (!res.ok) return { error: `${shown} answered HTTP ${res.status}` }
  const text = (await res.text()).slice(0, BODY_MAX)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: `${shown} did not answer JSON` }
  }
  const v = valueAt(data, s.path)
  return typeof v === "number" ? { value: v } : v
}

/** A failure's code or name only (ECONNREFUSED, TimeoutError). Its message
 *  can quote the address, a header or the command, so it is never kept. */
function errorName(e: unknown): string {
  const err = e as { cause?: { code?: unknown }; code?: unknown; name?: unknown } | null
  const name = [err?.cause?.code, err?.code, err?.name].find((v) => typeof v === "string" && /^[A-Za-z_][\w]{0,40}$/.test(v))
  return (name as string | undefined) ?? "error"
}

/** Why the command gave no output, in words of our own: its message has
 *  the full command, and its stderr can print a token. */
export function commandError(err: { code?: unknown; signal?: unknown; killed?: boolean }, timeoutMs: number): string {
  if (typeof err.code === "number") return `the command exited with code ${err.code}`
  if (err.killed && err.code == null && err.signal === "SIGTERM") return `the command timed out after ${Math.round(timeoutMs / 1000)}s`
  if (typeof err.signal === "string") return `the command was stopped by ${err.signal}`
  return `the command could not run (${errorName(err)})`
}

/** The default runner: `sh -c`, the window in AGENTX_PERIOD_START and
 *  AGENTX_PERIOD_END. */
export function shellRunner(cwd?: string): NonNullable<ReaderDeps["run"]> {
  return (command, env, timeoutMs) => new Promise((resolve) => {
    execFile("sh", ["-c", command], { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: BODY_MAX }, (err, stdout) => {
      if (err) resolve({ error: commandError(err, timeoutMs) })
      else resolve({ stdout: String(stdout) })
    })
  })
}

async function readCommand(s: CommandSource, period: Period, deps: ReaderDeps): Promise<ReadResult> {
  const run = deps.run ?? shellRunner(deps.cwd)
  const out = await run(s.command, { AGENTX_PERIOD_START: isoDay(period.start), AGENTX_PERIOD_END: isoDay(period.end - 1) }, s.timeoutSeconds * 1000)
  if ("error" in out) return out
  const text = out.stdout.trim()
  if (!text) return { error: "the command printed nothing" }
  if (!s.path) {
    const last = text.split("\n").pop()!.trim()
    const v = valueAt(last, "")
    return typeof v === "number" ? { value: v } : { error: "the command's last line is not a number" }
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: "the command did not print JSON" }
  }
  const v = valueAt(data, s.path)
  return typeof v === "number" ? { value: v } : v
}
