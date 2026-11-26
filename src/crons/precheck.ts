import { execFile } from "child_process"
import { fetch as undiciFetch } from "undici"
import { safeFetch } from "@/requests/checkers/fetch-guard"

// --- Schedule precheck (#2115) ---
//
// A cheap check run before a scheduled prompt job wakes its agent. It only
// decides whether there is work; it never does the job, and it must be
// read-only. No model is called for it.
//
//   command: exit 0 = work, run the job; exit 1 = nothing to do, skip it.
//   url:     2xx with a body = run; 204 (or a 2xx with an empty body) = skip.
//   Anything else (another exit code, a timeout, a fetch error, a non-2xx
//   status) is a failed check: the job runs anyway (fail open). One run
//   spent is cheaper than a wake lost without anyone noticing.
//
// What the check printed (trimmed, at most 2 KB) goes into the prompt as
// "Precheck found: …", so the agent starts from what the check saw.

export const PRECHECK_DEFAULT_TIMEOUT_SEC = 15
export const PRECHECK_MAX_TIMEOUT_SEC = 60
export const PRECHECK_FOUND_MAX = 2048
/** Ledger reason of a skipped run. */
export const PRECHECK_SKIP_REASON = "precheck: nothing to do"

export interface CronPrecheck {
  /** Program and arguments, split on spaces (quotes group). Run without a
   *  shell, in the agent's workspace, with the agent's env. */
  command?: string
  /** GET this address. */
  url?: string
  /** Seconds before the check counts as failed. Default 15, at most 60. */
  timeoutSec?: number
  /** Let a `url` reach a private or loopback host (the daemon's own API). */
  allowPrivate?: boolean
}

export type PrecheckOutcome =
  | { verdict: "run"; found: string }
  | { verdict: "skip"; detail: string }
  | { verdict: "error"; detail: string }

export interface PrecheckDeps {
  /** The agent's workspace; the command runs there. */
  cwd?: string
  /** The agent's env. */
  env?: NodeJS.ProcessEnv
  /** Tests give their own; otherwise the guarded fetch (#2122). */
  fetch?: typeof fetch
}

/** Split a command line into argv. Spaces separate; single or double
 *  quotes group; no expansion, no pipes, no shell. */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | null = null
  let has = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ""
      has = false
    } else {
      cur += ch
    }
  }
  if (quote) throw new Error("unclosed quote in precheck command")
  if (has || cur) out.push(cur)
  return out
}

/** What the check saw, trimmed and capped for the prompt. */
export function capFound(text: string): string {
  const t = text.trim()
  return t.length <= PRECHECK_FOUND_MAX ? t : `${t.slice(0, PRECHECK_FOUND_MAX)}…`
}

/** Put what the precheck found ahead of the job's prompt. */
export function withPrecheckFirst(found: string | undefined, prompt: string): string {
  return found ? `Precheck found:\n${found}\n\n${prompt}` : prompt
}

function timeoutMs(pc: CronPrecheck): number {
  const sec = Math.min(Math.max(pc.timeoutSec ?? PRECHECK_DEFAULT_TIMEOUT_SEC, 1), PRECHECK_MAX_TIMEOUT_SEC)
  return sec * 1000
}

/** Run one precheck. Never throws: a failure is the `error` verdict. */
export async function runPrecheck(pc: CronPrecheck, deps: PrecheckDeps = {}): Promise<PrecheckOutcome> {
  try {
    if (pc.command?.trim()) return await runCommand(pc.command, timeoutMs(pc), deps)
    if (pc.url?.trim()) return await runUrl(pc.url.trim(), timeoutMs(pc), pc.allowPrivate === true, deps)
    return { verdict: "error", detail: "precheck has neither command nor url" }
  } catch (e: any) {
    return { verdict: "error", detail: String(e?.message ?? e).slice(0, 300) }
  }
}

function runCommand(line: string, ms: number, deps: PrecheckDeps): Promise<PrecheckOutcome> {
  const [file, ...args] = splitCommand(line.trim())
  if (!file) return Promise.resolve({ verdict: "error", detail: "precheck command is empty" })
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: deps.cwd, env: deps.env, timeout: ms, maxBuffer: 1024 * 1024 },
      (err: any, stdout, stderr) => {
        if (err?.killed) return resolve({ verdict: "error", detail: `timed out after ${Math.round(ms / 1000)}s` })
        if (!err) return resolve({ verdict: "run", found: capFound(String(stdout ?? "")) })
        if (err.code === 1) return resolve({ verdict: "skip", detail: "exit 1" })
        const why = typeof err.code === "number" ? `exit ${err.code}` : String(err.message ?? err.code ?? err)
        const tail = String(stderr ?? "").trim().slice(-200)
        resolve({ verdict: "error", detail: tail ? `${why}: ${tail}` : why })
      },
    )
  })
}

async function runUrl(url: string, ms: number, allowPrivate: boolean, deps: PrecheckDeps): Promise<PrecheckOutcome> {
  const doFetch: typeof fetch = deps.fetch
    ?? (allowPrivate ? ((u, i) => undiciFetch(u as any, i as any) as unknown as Promise<Response>) : safeFetch)
  const res = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(ms), redirect: "follow" })
  if (res.status === 204) return { verdict: "skip", detail: "HTTP 204" }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => {})
    return { verdict: "error", detail: `HTTP ${res.status}` }
  }
  const body = capFound(await res.text())
  if (!body) return { verdict: "skip", detail: `HTTP ${res.status} with an empty body` }
  return { verdict: "run", found: body }
}
