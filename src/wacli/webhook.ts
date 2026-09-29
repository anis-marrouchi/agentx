import type { IncomingMessage, ServerResponse } from "http"
import { readRaw } from "@/daemon/voice-io-api"
import { parseWacliMessage } from "./rules"
import type { ReceiveResult } from "./service"
import { verifyWacliSignature } from "./signature"

// --- POST /webhook/wacli ---
//
// Where `wacli sync --webhook <url> --webhook-secret <secret>` posts each
// live message. The signature is checked over the raw body before anything
// is parsed; unsigned or wrongly signed requests get 401. Receipts,
// presence and the owner's own messages are acknowledged and dropped.

export const WACLI_WEBHOOK_PATH = "/webhook/wacli"
const BODY_MAX = 1024 * 1024

export interface WacliWebhookDeps {
  /** Null when triage is off. */
  receive: ((msg: NonNullable<ReturnType<typeof parseWacliMessage>>) => ReceiveResult) | null
  secret: () => string | undefined
  log: (line: string) => void
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
}

export async function handleWacliWebhook(req: IncomingMessage, res: ServerResponse, deps: WacliWebhookDeps): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "POST" })
  if (!deps.receive) { req.resume(); return json(res, 404, { error: "WhatsApp triage is off (wacli.enabled)" }) }
  const secret = deps.secret()
  if (!secret) { req.resume(); deps.log("[wacli] webhook refused: no secret configured"); return json(res, 401, { error: "no webhook secret is configured" }) }
  const body = await readRaw(req, BODY_MAX)
  if (!body) return json(res, 413, { error: "body too large" })
  if (!verifyWacliSignature(secret, body, req.headers["x-wacli-signature"])) {
    deps.log("[wacli] webhook refused: missing or wrong signature")
    return json(res, 401, { error: "invalid signature" })
  }
  let raw: unknown
  try { raw = JSON.parse(body.toString("utf-8")) } catch { return json(res, 400, { error: "expected JSON" }) }
  const msg = parseWacliMessage(raw)
  if (!msg) return json(res, 202, { ok: true, result: "ignored" })
  return json(res, 202, { ok: true, result: deps.receive(msg) })
}
