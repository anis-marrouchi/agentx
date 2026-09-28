import type { IncomingMessage, ServerResponse } from "http"
import type { TokenRecord } from "./token-store"
import type { DaemonConfig } from "./config"
import { PushPrefs } from "@/channels/push-prefs"
import { openDb } from "@/storage/sqlite"
import { dashboardTokenForNode } from "./mesh-auth"

// --- Phone app: mesh announcements (/api/app/announcements*) (#268) ---
//
// Runs behind the device-token check in app-routes.ts.
//
//   GET /api/app/announcements   recent announcements, newest first,
//                                plus this phone's notify switch
//
// The list comes from the primary daemon's /events/recent?kind=announce,
// which already holds peers' announcements (the peer feed). Only short
// fields leave: text, who, node, time. The switch is the "announce" row in
// push_prefs, set through POST /api/app/push/prefs { announce } like the
// other notification switches (app-push.ts).

export const ANNOUNCE_LIST_MAX = 50
export const ANNOUNCE_TEXT_MAX = 280

export interface AppAnnouncement {
  id: string
  text: string
  /** Agent that announced, when it was an agent. */
  by: string | null
  node: string
  at: string
}

export interface AppAnnounceDeps {
  /** Recent announce envelopes, in any order. Throws when unreachable. */
  recent: (limit: number) => Promise<unknown[]>
  /** Null when this computer doesn't send notifications. */
  prefs: () => PushPrefs | null
}

export async function handleAppAnnounce(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  device: TokenRecord,
  deps: AppAnnounceDeps,
): Promise<boolean> {
  if (path !== "/api/app/announcements") return false
  if (method === "GET") {
    const prefs = deps.prefs()
    let items: AppAnnouncement[] = []
    let error: string | null = null
    try {
      items = toAnnouncements(await deps.recent(ANNOUNCE_LIST_MAX))
    } catch (e: any) {
      error = String(e?.message || "unreachable").slice(0, 200)
    }
    return json(res, 200, { items, error, notify: prefs ? prefs.on(device.id, "announce") : false, notifyAvailable: !!prefs })
  }
  return json(res, 404, { error: "not found" })
}

/** Built per request by the dashboard, so a config reload is picked up.
 *  The setting is only offered where the phone's pushes are sent from:
 *  push enabled here and not relayed to another node. */
export function appAnnounceDeps(config: DaemonConfig): AppAnnounceDeps {
  const primary = config.dashboard.daemonUrl.replace(/\/+$/, "")
  const token = process.env.MESH_TOKEN || dashboardTokenForNode(config.dashboard, primary)
  const push = config.channels.push
  return {
    async recent(limit) {
      const r = await fetch(`${primary}/events/recent?kind=announce&limit=${limit}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(5000),
      })
      if (!r.ok) throw new Error(`the daemon answered ${r.status}`)
      const body = await r.json() as { events?: unknown[] }
      return body.events ?? []
    },
    prefs: () => {
      if (!push.enabled || push.relayTo) return null
      const db = openDb()
      return db ? new PushPrefs(db) : null
    },
  }
}

/** Keeps well-formed announce envelopes, newest first, bounded and capped. */
export function toAnnouncements(events: unknown[]): AppAnnouncement[] {
  const out: AppAnnouncement[] = []
  for (const raw of Array.isArray(events) ? events : []) {
    const e = raw as Record<string, unknown>
    if (!e || e.kind !== "announce" || typeof e.id !== "string" || typeof e.at !== "string") continue
    out.push({
      id: e.id.slice(0, 64),
      text: cap(typeof e.summary === "string" ? e.summary : "", ANNOUNCE_TEXT_MAX),
      by: typeof e.agentId === "string" ? cap(e.agentId, 100) : null,
      node: cap(typeof e.node === "string" ? e.node : "", 100),
      at: e.at.slice(0, 40),
    })
  }
  out.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
  return out.slice(0, ANNOUNCE_LIST_MAX)
}

function cap(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
