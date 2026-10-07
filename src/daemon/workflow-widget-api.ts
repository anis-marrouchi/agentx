import type { IncomingMessage, ServerResponse } from "http"
import { readJson } from "./app-fleet"
import { widgetRows, type NodeRun, type WidgetRow, type WidgetSettings } from "@/workflows/widget"

// --- The progress widget's data and answers (#796) ---
//
// Two doors, one set of rows:
//   GET  /api/workflows/widget[?tag=]     dashboard (the /workflows/widget page)
//   POST /api/workflows/widget/answer     { node, runId, action, text? }
//   GET  /api/app/workflows[?tag=]        phone app, Activity tab
//   POST /api/app/workflows/answer        same body
//
// `action` is "yes" or "no" for a row waiting on a decision card, or
// "reply" with `text` for a blocked agent step. The body also names the
// `step` (and, for a card, its `key`) the owner saw. An answer is checked
// against the rows as they are now: one sent from a stale view after the
// step moved on, or after a new card replaced the one on screen, is
// refused instead of landing on something else.

export interface WidgetReply { status: number; body: unknown }

export interface WidgetApiDeps {
  settings(): WidgetSettings
  /** Every run the dashboard can read, with the node it lives on. */
  nodeRuns(): Promise<{ runs: NodeRun[]; unreachable: string[] }>
  title?: (workflowId: string) => string | undefined
  stepAgent?: (workflowId: string, nodeId: string) => string | undefined
  hasChoices?: (workflowId: string, nodeId: string) => boolean
  /** Answer a decision card on the node that holds it. */
  decide(node: string, key: string, action: "yes" | "no", by: string): Promise<WidgetReply>
  /** Hand the owner's answer to the blocked step's agent, on its node. */
  reply(node: string, runId: string, step: string, text: string, by: string): Promise<WidgetReply>
}

export interface WidgetSnapshot {
  ts: string
  enabled: boolean
  settings: WidgetSettings
  rows: WidgetRow[]
  unreachable: string[]
}

export async function widgetSnapshot(deps: WidgetApiDeps, tag?: string | null): Promise<WidgetSnapshot> {
  const settings = deps.settings()
  const ts = new Date().toISOString()
  if (!settings.enabled) return { ts, enabled: false, settings, rows: [], unreachable: [] }
  const { runs, unreachable } = await deps.nodeRuns()
  const tags = tag ? [tag] : settings.tags
  return { ts, enabled: true, settings, rows: widgetRows(runs, { title: deps.title, stepAgent: deps.stepAgent, hasChoices: deps.hasChoices, tags }), unreachable }
}

export async function widgetAnswer(body: Record<string, unknown>, deps: WidgetApiDeps, by: string): Promise<WidgetReply> {
  const node = str(body.node)
  const runId = str(body.runId)
  const step = str(body.step)
  const action = str(body.action)
  if (!node || !runId || !step) return { status: 400, body: { error: "node, runId and step are required" } }
  if (action !== "yes" && action !== "no" && action !== "reply") return { status: 400, body: { error: "action is yes, no or reply" } }
  const settings = deps.settings()
  if (!settings.enabled) return { status: 409, body: { error: "the progress widget is off (workflows.widget.enabled)" } }
  // Every followed run, not only the tags shown: the row was on screen.
  const { runs } = await deps.nodeRuns()
  const row = widgetRows(runs, { title: deps.title, stepAgent: deps.stepAgent, hasChoices: deps.hasChoices }).find((r) => r.runId === runId && r.node === node)
  const moved = { status: 409, body: { error: "this step no longer waits on you: it has moved on or ended" } }
  if (!row?.answer || row.step !== step) return moved
  if (row.answer.kind === "card") {
    if (action === "reply") return { status: 400, body: { error: "this step waits on a decision: answer yes or no" } }
    // Another card on the same step (a new one raised after this was shown).
    if (str(body.key) !== row.answer.key) return moved
    if (row.answer.choices) return { status: 400, body: { error: "this card offers choices: answer it in the Approvals inbox" } }
    return deps.decide(node, row.answer.key, action, by)
  }
  if (action !== "reply") return { status: 400, body: { error: "this step is blocked: send a reply with text" } }
  const text = str(body.text)
  if (!text) return { status: 400, body: { error: "the reply is empty" } }
  return deps.reply(node, runId, step, text.slice(0, 2000), by)
}

/** The dashboard's two routes. Below its /api token and X-Requested-With
 *  checks. Returns false for any other path. */
export async function handleDashboardWidget(req: IncomingMessage, res: ServerResponse, path: string, method: string, deps: WidgetApiDeps): Promise<boolean> {
  if (method === "GET" && path === "/api/workflows/widget") {
    const url = new URL(req.url || path, "http://localhost")
    return json(res, 200, await widgetSnapshot(deps, url.searchParams.get("tag")))
  }
  if (method === "POST" && path === "/api/workflows/widget/answer") {
    let body: Record<string, unknown>
    try { body = await readJson(req) } catch (e: any) { return json(res, 400, { error: e.message }) }
    const r = await widgetAnswer(body, deps, "operator (progress widget)")
    return json(res, r.status, r.body)
  }
  return false
}

/** The phone app's two routes, behind its device token (app-routes.ts). */
export async function handleAppWorkflows(req: IncomingMessage, res: ServerResponse, path: string, method: string, device: string, deps: WidgetApiDeps): Promise<boolean> {
  if (method === "GET" && path === "/api/app/workflows") {
    const url = new URL(req.url || path, "http://localhost")
    return json(res, 200, await widgetSnapshot(deps, url.searchParams.get("tag")))
  }
  if (method === "POST" && path === "/api/app/workflows/answer") {
    let body: Record<string, unknown>
    try { body = await readJson(req) } catch (e: any) { return json(res, 400, { error: e.message }) }
    const r = await widgetAnswer(body, deps, `operator (phone: ${device})`)
    return json(res, r.status, r.body)
  }
  return false
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
