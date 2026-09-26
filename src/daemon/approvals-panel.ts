import type { IncomingMessage, ServerResponse } from "http"
import { decide, listInbox, type InboxAction, type InboxContext } from "@/approvals/inbox"
import { parseDestination, readApprovalSettings, updateApprovalSettings, type ApprovalSettingsPatch } from "@/approvals/settings"
import { renderApprovalsPage } from "./ui/pages/approvals"
import type { TopbarPeer } from "./topbar"

// --- Dashboard side of the Approvals inbox ---
//
// The operator's surface. Runs in the dashboard process (`agentx board
// serve`), behind the same checks as every /api/admin route: the dashboard
// token when one is configured, and X-Requested-With from a same-origin page
// (browser-origin.ts refuses pages from other origins before this runs).
// Agents never reach decide() through the daemon; see daemon-api.ts.
//
//   GET  /approvals                        the page
//   GET  /api/admin/approvals[?all=1]      inbox + settings
//   POST /api/admin/approvals/decide       { key, action: yes|no|later, note?, force? }
//   POST /api/admin/approvals/settings     settings form

const ACTIONS: readonly InboxAction[] = ["yes", "no", "later"]

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error("body too large")
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString("utf-8")
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object")
  return parsed
}

export function handleApprovalsPageGet(res: ServerResponse, peers: TopbarPeer[], localToken?: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(renderApprovalsPage({ peers, localToken }))
}

export interface ApprovalsPanelOpts {
  ctx?: InboxContext
  configPath?: string
  /** Hot-reload the daemon after config writes. Default true. */
  reload?: boolean
}

/** Returns false when the path isn't one of ours. */
export async function handleApprovalsPanelApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  opts: ApprovalsPanelOpts = {},
): Promise<boolean> {
  if (!path.startsWith("/api/admin/approvals")) return false
  const method = (req.method || "GET").toUpperCase()
  const ctx: InboxContext = opts.ctx ?? { root: process.cwd(), configPath: opts.configPath, reload: opts.reload }

  if (method !== "GET" && req.headers["x-requested-with"] !== "agentx-board") {
    sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" })
    return true
  }

  try {
    if (method === "GET" && path === "/api/admin/approvals") {
      const listing = listInbox(ctx, { includeSnoozed: url.searchParams.get("all") === "1" })
      sendJson(res, 200, { ...listing, settings: readApprovalSettings(ctx.configPath) })
      return true
    }

    if (method === "POST" && path === "/api/admin/approvals/decide") {
      const body = await readJson(req)
      const key = typeof body.key === "string" ? body.key : ""
      const action = body.action as InboxAction
      if (!key || !ACTIONS.includes(action)) {
        sendJson(res, 400, { error: "send { key, action: yes | no | later }" })
        return true
      }
      const settings = readApprovalSettings(ctx.configPath)
      const r = await decide(ctx, key, action, {
        note: typeof body.note === "string" ? body.note : undefined,
        force: body.force === true,
        laterHours: settings.laterHours,
        by: "operator (dashboard)",
      })
      if (!r.ok) { sendJson(res, 409, { error: r.error }); return true }
      sendJson(res, 200, { ok: true, message: r.message })
      return true
    }

    if (method === "POST" && path === "/api/admin/approvals/settings") {
      const body = await readJson(req)
      const patch: ApprovalSettingsPatch = {}
      const num = (k: string) => {
        const v = body[k]
        if (v === undefined) return undefined
        if (typeof v !== "number" || !(v > 0)) throw new Error(`${k} must be a positive number`)
        return v
      }
      patch.defaultExpiryDays = num("defaultExpiryDays")
      patch.maxExpiryDays = num("maxExpiryDays")
      patch.laterHours = num("laterHours")
      if (typeof body.notifyAgent === "boolean") patch.notifyAgent = body.notifyAgent
      if (typeof body.digestEnabled === "boolean") patch.digestEnabled = body.digestEnabled
      if (typeof body.digestTime === "string") patch.digestTime = body.digestTime
      if (typeof body.destination === "string") {
        const raw = body.destination.trim()
        if (!raw) patch.destination = null
        else {
          const d = parseDestination(raw)
          if (!d) throw new Error("digest destination takes channel:chat id, for example telegram:123456")
          patch.destination = d
        }
      }
      const r = await updateApprovalSettings(patch, { configPath: ctx.configPath, reload: ctx.reload })
      if (!r.success) { sendJson(res, 400, { error: r.error }); return true }
      sendJson(res, 200, { ok: true, settings: readApprovalSettings(ctx.configPath) })
      return true
    }
  } catch (e: any) {
    sendJson(res, 400, { error: String(e?.message ?? e).slice(0, 300) })
    return true
  }

  sendJson(res, 404, { error: "Not found" })
  return true
}
