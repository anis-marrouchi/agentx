import { createHash, randomBytes, timingSafeEqual } from "crypto"
import type { IncomingMessage, ServerResponse } from "http"
import { MAX_ROUTINE_BODY_BYTES } from "@/crons/event-payload"
import type { FireNowResult } from "@/crons/scheduler"
import type { EntityRef, Workflow, WorkflowRun } from "@/workflows/types"
import type { TriggerEvent } from "@/workflows/dispatcher"

// --- POST /routines/:id/fire ---
//
// Fires exactly one routine now: a cron job (`crons.<id>`) or a workflow
// whose trigger is `trigger.cron` / `trigger.hook`. The JSON body is the
// run's context — appended to a cron prompt as an untrusted "Event
// payload" block, or handed to a workflow as its trigger output.
//
// Firing is opt-in per routine: a routine without `fireToken` cannot be
// fired (403). Callers present that token as `Authorization: Bearer` or
// `X-AgentX-Routine-Token`. A mesh token also works as a Bearer, so a peer
// that can already POST /task can fire routines. There is deliberately NO
// loopback exemption: this endpoint is meant to be reached by outside
// systems, typically through a reverse proxy on the same host, whose
// requests all arrive from 127.0.0.1.
//
// Status codes: 202 started · 400 invalid JSON · 401 bad/missing token ·
// 403 not fireable · 404 unknown · 409 disabled / ambiguous ·
// 413 body too large · 503 scheduler or workflow engine not running.

export const ROUTINE_FIRE_PATH = /^\/routines\/([^/]+)\/fire$/

/** Trigger types a workflow must have to be fireable. */
const FIREABLE_WORKFLOW_TRIGGERS = new Set(["trigger.cron", "trigger.hook"])

export interface RoutineFireDeps {
  cron: {
    hasJob(id: string): boolean
    getFireToken(id: string): string | undefined
    fireNow(id: string, payload: unknown): FireNowResult
  }
  workflows?: {
    get(id: string): Workflow | null | undefined
    dispatchWorkflow(args: {
      workflowId: string
      entityRef: EntityRef
      event: TriggerEvent
      trigger?: { source?: string }
    }): Promise<{ claimed: boolean; run: WorkflowRun | null }>
  }
  /** Mesh tokens this node accepts (MESH_TOKEN + peer tokens). */
  meshTokens: ReadonlySet<string>
  env?: Record<string, string | undefined>
  log: (msg: string) => void
}

type Resolved =
  | { kind: "cron"; id: string; token?: string }
  | { kind: "workflow"; id: string; token?: string; workflow: Workflow; triggerType: string }

/**
 * A workflow's fire token lives on its trigger node as `config.fireToken`
 * and MUST be an env reference (`${NAME}`). Workflow definitions are served
 * by GET /api/workflows, so a literal secret there would be readable by
 * anyone who can list workflows; the reference name is not a secret.
 */
export function resolveWorkflowFireToken(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): { token?: string; problem?: string } {
  if (typeof raw !== "string" || !raw.trim()) return {}
  const m = raw.trim().match(/^\$\{(\w+)\}$/)
  if (!m) return { problem: "fireToken must be an env reference like ${MY_TOKEN}, not a literal" }
  const value = env[m[1]]?.trim()
  if (!value) return { problem: `fireToken env var ${m[1]} is not set` }
  return { token: value }
}

/** Constant-time string compare (hashing first equalizes lengths). */
export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest()
  const hb = createHash("sha256").update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** Token presented by the caller, from either accepted header. */
export function presentedToken(headers: IncomingMessage["headers"]): string {
  const custom = headers["x-agentx-routine-token"]
  const fromCustom = (Array.isArray(custom) ? custom[0] : custom)?.trim()
  if (fromCustom) return fromCustom
  const auth = String(headers["authorization"] || "")
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
}

export type FireAuthDecision =
  | { allowed: true; via: "routine-token" | "mesh-token" }
  | { allowed: false; status: 401 | 403 }

/** Pure auth decision, for a routine already known to exist. */
export function decideRoutineFireAuth(args: {
  configuredToken?: string
  presented: string
  meshTokens: ReadonlySet<string>
}): FireAuthDecision {
  if (!args.configuredToken) return { allowed: false, status: 403 }
  if (!args.presented) return { allowed: false, status: 401 }
  if (tokensEqual(args.presented, args.configuredToken)) return { allowed: true, via: "routine-token" }
  for (const t of args.meshTokens) {
    if (t && tokensEqual(args.presented, t)) return { allowed: true, via: "mesh-token" }
  }
  return { allowed: false, status: 401 }
}

export type BodyResult =
  | { ok: true; payload: unknown }
  | { ok: false; status: 400 | 413; error: string }

/** Read a JSON body, refusing anything over `maxBytes`. Empty body → {}. */
export function readRoutineBody(req: IncomingMessage, maxBytes = MAX_ROUTINE_BODY_BYTES): Promise<BodyResult> {
  const declared = Number(req.headers["content-length"])
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume()
    return Promise.resolve({ ok: false, status: 413, error: `body exceeds ${maxBytes} bytes` })
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (r: BodyResult) => { if (!done) { done = true; resolve(r) } }
    req.on("data", (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > maxBytes) {
        finish({ ok: false, status: 413, error: `body exceeds ${maxBytes} bytes` })
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8").trim()
      if (!text) return finish({ ok: true, payload: {} })
      try {
        finish({ ok: true, payload: JSON.parse(text) })
      } catch {
        finish({ ok: false, status: 400, error: "body must be JSON" })
      }
    })
    req.on("error", () => finish({ ok: false, status: 400, error: "could not read body" }))
  })
}

function resolveRoutine(id: string, deps: RoutineFireDeps): Resolved[] {
  const found: Resolved[] = []
  if (deps.cron.hasJob(id)) found.push({ kind: "cron", id, token: deps.cron.getFireToken(id) })
  const wf = deps.workflows?.get(id)
  if (wf) {
    const trigger = wf.nodes.find((n) => n.type.startsWith("trigger."))
    if (trigger && FIREABLE_WORKFLOW_TRIGGERS.has(trigger.type)) {
      const cfg = (trigger.config ?? {}) as { fireToken?: unknown }
      const { token, problem } = resolveWorkflowFireToken(cfg.fireToken, deps.env ?? process.env)
      if (problem) deps.log(`[routines] workflow "${id}": ${problem}`)
      found.push({ kind: "workflow", id, token, workflow: wf, triggerType: trigger.type })
    }
  }
  return found
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

/** Handle POST /routines/:id/fire. `rawId` is the still-encoded path segment. */
export async function handleRoutineFire(
  req: IncomingMessage,
  res: ServerResponse,
  rawId: string,
  deps: RoutineFireDeps,
): Promise<void> {
  let id: string
  try { id = decodeURIComponent(rawId) } catch { id = rawId }
  const addr = req.socket?.remoteAddress || ""

  const matches = resolveRoutine(id, deps)
  if (matches.length === 0) {
    req.resume()
    return send(res, 404, { error: "unknown routine" })
  }

  // Auth first (before reading the body or revealing more). With two
  // routines of the same id, the token must match one of them — then the
  // ambiguity is reported.
  const presented = presentedToken(req.headers)
  const decisions = matches.map((m) =>
    decideRoutineFireAuth({ configuredToken: m.token, presented, meshTokens: deps.meshTokens }))
  const allowedIdx = decisions.findIndex((d) => d.allowed)
  if (allowedIdx === -1) {
    req.resume()
    const status = decisions.every((d) => !d.allowed && d.status === 403) ? 403 : 401
    deps.log(`[routines] ✗ fire "${id}" from ${addr} rejected (${status})`)
    return send(res, status, status === 403
      ? { error: "routine is not fireable: no fireToken configured" }
      : { error: "missing or invalid routine token" })
  }
  if (matches.length > 1) {
    req.resume()
    return send(res, 409, { error: `ambiguous routine id: "${id}" names both a cron job and a workflow` })
  }
  const routine = matches[0]

  const body = await readRoutineBody(req)
  if (!body.ok) return send(res, body.status, { error: body.error })

  if (routine.kind === "cron") {
    const r = deps.cron.fireNow(routine.id, body.payload)
    if (!r.ok) {
      if (r.reason === "disabled") return send(res, 409, { error: "routine is disabled" })
      if (r.reason === "not-running") return send(res, 503, { error: "scheduler not running" })
      return send(res, 404, { error: "unknown routine" })
    }
    deps.log(`[routines] fired cron "${routine.id}" from ${addr} → run ${r.runId}`)
    return send(res, 202, { ok: true, routine: routine.id, kind: "cron", runId: r.runId, startedAt: r.startedAt })
  }

  const wf = routine.workflow
  if (wf.state && wf.state !== "active") return send(res, 409, { error: `routine is ${wf.state}` })
  if (!deps.workflows) return send(res, 503, { error: "workflow engine not running" })

  const firedAt = new Date().toISOString()
  const nonce = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`
  const result = await deps.workflows.dispatchWorkflow({
    workflowId: wf.id,
    trigger: { source: "routine-fire" },
    // A fresh entity per fire, so each call starts its own run.
    entityRef: { backend: "routine", id: `${wf.id}@fire:${nonce}` },
    event: {
      id: `routine-fire:${wf.id}:${nonce}`,
      payload: {
        workflowId: wf.id,
        now: firedAt,
        firedVia: "routine-fire",
        // The caller's JSON. Templates read it as {{<trigger>.payload.…}}.
        payload: body.payload,
        payloadUntrusted: true,
      },
    },
  })
  if (!result.run) return send(res, 500, { error: "workflow did not start a run" })
  deps.log(`[routines] fired workflow "${wf.id}" from ${addr} → run ${result.run.id}`)
  return send(res, 202, { ok: true, routine: wf.id, kind: "workflow", runId: result.run.id, startedAt: firedAt })
}
