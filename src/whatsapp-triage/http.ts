import type { IncomingMessage, ServerResponse } from "http"
import type { WhatsappTriageConfig } from "./config"
import { parseWacliMessage, SIGNATURE_HEADER, verifyWacliSignature } from "./message"
import type { TriageService } from "./service"

// --- POST /webhook/wacli ---
//
// The signature is the only gate: this path is outside mesh auth so wacli
// can reach it. No secret configured means every request is refused.

export const WACLI_WEBHOOK_PATH = "/webhook/wacli"
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

export interface WacliWebhookDeps {
  config: () => WhatsappTriageConfig
  service: () => TriageService | null
  env?: NodeJS.ProcessEnv
  log: (m: string) => void
}

export async function handleWacliWebhook(req: IncomingMessage, res: ServerResponse, deps: WacliWebhookDeps): Promise<void> {
  const cfg = deps.config()
  const service = deps.service()
  if (!cfg.enabled || !service) return reply(res, 404, { error: "WhatsApp triage is off" })
  const secret = (deps.env ?? process.env)[cfg.secretEnv] ?? ""
  if (!secret) {
    deps.log(`[whatsapp-triage] refused a webhook: ${cfg.secretEnv} is not set`)
    return reply(res, 503, { error: `no webhook secret: set ${cfg.secretEnv}` })
  }
  const raw = await readRaw(req, BODY_MAX)
  if (!raw) return reply(res, 413, { error: "request too large" })
  if (!verifyWacliSignature(raw, req.headers[SIGNATURE_HEADER], secret)) {
    return reply(res, 401, { error: "missing or wrong X-Wacli-Signature" })
  }
  let body: unknown
  try { body = JSON.parse(raw.toString("utf8")) } catch { return reply(res, 400, { error: "expected JSON" }) }
  const msg = parseWacliMessage(body)
  if (!msg) return reply(res, 200, { ok: true, status: "ignored" })
  const r = service.receive(msg)
  return reply(res, 200, { ok: true, ...r })
}
