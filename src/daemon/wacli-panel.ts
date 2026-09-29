import type { IncomingMessage, ServerResponse } from "http"
import { normalizeJid } from "@/wacli/rules"
import { readWacliConfig, removeWacliRule, saveWacliRule, updateWacliSettings, wacliSummary, type WacliSettingsPatch } from "@/wacli/settings"

// --- Dashboard side of WhatsApp triage (#328) ---
//
// The settings and watch rules section on the Approvals page. Mounted after
// the /api/admin token check in board-dashboard.ts, and like every admin
// write it needs X-Requested-With from a same-origin page. The secret is
// never read or written here: it stays in agentx.json or the environment.
//
//   GET  /api/admin/wacli                 settings (no secret) + rules
//   POST /api/admin/wacli/settings        { enabled?, batchSeconds?, media? }
//   POST /api/admin/wacli/rules           a rule; replaces one with the same id
//   POST /api/admin/wacli/rules/remove    { id }

export interface WacliPanelOpts {
  configPath?: string
  /** Hot-reload the daemon after config writes. Default true. */
  reload?: boolean
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, any>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error("body too large")
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString("utf-8")
  const parsed = raw.trim() ? JSON.parse(raw) : {}
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object")
  return parsed
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)

/** A rule from the form, in the shape agentx.json stores. */
export function ruleFromForm(body: Record<string, any>): Record<string, unknown> {
  const rule: Record<string, unknown> = { id: str(body.id), agent: str(body.agent) }
  const chat = str(body.chat)
  const sender = str(body.sender)
  if (chat) rule.chat = normalizeJid(chat)
  if (sender) rule.sender = normalizeJid(sender)
  if (str(body.group)) rule.group = str(body.group)
  if (str(body.prompt)) rule.prompt = str(body.prompt)
  const start = str(body.quietStart)
  const end = str(body.quietEnd)
  if (start && end) rule.quietHours = { start, end, ...(str(body.timezone) ? { timezone: str(body.timezone) } : {}) }
  if (body.autoAck === true) rule.autoAck = true
  if (body.enabled === false) rule.enabled = false
  return rule
}

/** Returns false when the path isn't one of ours. */
export async function handleWacliPanelApi(req: IncomingMessage, res: ServerResponse, path: string, opts: WacliPanelOpts = {}): Promise<boolean> {
  if (path !== "/api/admin/wacli" && !path.startsWith("/api/admin/wacli/")) return false
  const method = (req.method || "GET").toUpperCase()
  const mutation = { configPath: opts.configPath, reload: opts.reload }
  if (method !== "GET" && req.headers["x-requested-with"] !== "agentx-board") {
    sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" })
    return true
  }
  const done = (r: { success: boolean; error?: string }) => r.success
    ? sendJson(res, 200, { ok: true, wacli: wacliSummary(readWacliConfig(opts.configPath)) })
    : sendJson(res, 400, { error: r.error ?? "not saved" })

  try {
    if (method === "GET" && path === "/api/admin/wacli") {
      sendJson(res, 200, { wacli: wacliSummary(readWacliConfig(opts.configPath)) })
      return true
    }
    if (method === "POST" && path === "/api/admin/wacli/settings") {
      const body = await readJson(req)
      const patch: WacliSettingsPatch = {}
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled
      if (typeof body.media === "boolean") patch.media = body.media
      if (body.batchSeconds !== undefined) {
        if (!Number.isInteger(body.batchSeconds) || body.batchSeconds < 0 || body.batchSeconds > 600) throw new Error("batchSeconds takes a whole number from 0 to 600")
        patch.batchSeconds = body.batchSeconds
      }
      done(await updateWacliSettings(patch, mutation))
      return true
    }
    if (method === "POST" && path === "/api/admin/wacli/rules") {
      done(await saveWacliRule(ruleFromForm(await readJson(req)), mutation))
      return true
    }
    if (method === "POST" && path === "/api/admin/wacli/rules/remove") {
      const id = str((await readJson(req)).id)
      if (!id) throw new Error("send { id }")
      done(await removeWacliRule(id, mutation))
      return true
    }
    sendJson(res, 404, { error: "not found" })
  } catch (e: any) {
    sendJson(res, 400, { error: e?.message ?? String(e) })
  }
  return true
}
