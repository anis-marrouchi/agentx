import type { IncomingMessage, ServerResponse } from "http"
import type { z } from "zod"
import type { trackersConfigSchema } from "@/daemon/config"
import {
  createJiraClient, createLinearClient, parseJiraWebhook, parseLinearWebhook, verifyJiraSignature, verifyLinearSignature,
  type TrackerClient, type TrackerDispatcher, type TrackerName, type TrackerRoute,
} from "./index"

// --- POST /webhook/linear and /webhook/jira (#1292) ---
//
// Outside mesh auth so Linear and Jira can reach them: the signature is the
// only gate, and with no secret set every request is refused.

export type TrackersConfig = z.infer<typeof trackersConfigSchema>

export const TRACKER_WEBHOOK_PATHS: Record<string, TrackerName> = { "/webhook/linear": "linear", "/webhook/jira": "jira" }

const BODY_MAX = 1024 * 1024

function readRaw(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (c: Buffer) => {
      size += c.length
      if (size > max) { resolve(null); req.destroy(); return }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", () => resolve(null))
  })
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

/** Each enabled tracker's client and routes. Jira needs its `baseUrl`. */
export function trackerClients(cfg: TrackersConfig, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Array<{ client: TrackerClient; routes: TrackerRoute[] }> {
  const out: Array<{ client: TrackerClient; routes: TrackerRoute[] }> = []
  if (cfg.linear.enabled) {
    out.push({
      client: createLinearClient(() => env[cfg.linear.apiKeyEnv], fetchImpl),
      routes: cfg.linear.routes.map((r) => ({ key: r.team, agent: r.agent, checkout: r.checkout })),
    })
  }
  if (cfg.jira.enabled && cfg.jira.baseUrl) {
    out.push({
      client: createJiraClient(cfg.jira.baseUrl, () => ({ email: env[cfg.jira.emailEnv], token: env[cfg.jira.tokenEnv] }), fetchImpl),
      routes: cfg.jira.routes.map((r) => ({ key: r.project, agent: r.agent, checkout: r.checkout })),
    })
  }
  return out
}

export interface TrackerWebhookDeps {
  config: () => TrackersConfig
  dispatcher: TrackerDispatcher
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  log: (line: string) => void
}

export async function handleTrackerWebhook(name: TrackerName, req: IncomingMessage, res: ServerResponse, deps: TrackerWebhookDeps): Promise<{ done?: Promise<void> }> {
  const cfg = deps.config()
  const env = deps.env ?? process.env
  const tc = cfg[name]
  if (!tc.enabled) { reply(res, 404, { error: `${name} is off (trackers.${name}.enabled)` }); return {} }
  const secret = env[tc.webhookSecretEnv] ?? ""
  if (!secret) {
    deps.log(`[trackers] refused a ${name} webhook: ${tc.webhookSecretEnv} is not set`)
    reply(res, 503, { error: `no webhook secret: set ${tc.webhookSecretEnv}` })
    return {}
  }
  const raw = await readRaw(req, BODY_MAX)
  if (!raw) { reply(res, 413, { error: "request too large" }); return {} }
  const signed = name === "linear"
    ? verifyLinearSignature(raw, req.headers["linear-signature"], secret)
    : verifyJiraSignature(raw, req.headers["x-hub-signature"], secret)
  if (!signed) { reply(res, 401, { error: `missing or wrong ${name === "linear" ? "Linear-Signature" : "X-Hub-Signature"}` }); return {} }
  let payload: unknown
  try { payload = JSON.parse(raw.toString("utf8")) } catch { reply(res, 400, { error: "expected JSON" }); return {} }
  const issue = name === "linear" ? parseLinearWebhook(payload, cfg.linear.label) : parseJiraWebhook(payload, cfg.jira.label, cfg.jira.baseUrl)
  if (!issue) { reply(res, 200, { ok: true, status: "ignored" }); return {} }
  const tracker = trackerClients(cfg, env, deps.fetchImpl).find((t) => t.client.name === name)
  if (!tracker) { reply(res, 503, { error: "trackers.jira.baseUrl is not set" }); return {} }
  const r = deps.dispatcher.dispatch(tracker.client, tracker.routes, issue)
  reply(res, 200, { ok: true, status: r.status, key: issue.key })
  return { done: r.done }
}
