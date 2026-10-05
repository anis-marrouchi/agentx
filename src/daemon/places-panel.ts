import type { IncomingMessage, ServerResponse } from "http"
import type Database from "better-sqlite3"
import { readJson } from "./app-fleet"
import { PlaceStore } from "@/places/store"
import {
  addPlace, addReminder, placesOverview, removePlace, removeReminder, updatePlace,
  type ApiAnswer, type PlacesSettings,
} from "@/places/api"
import { renderPlacesPage } from "./ui/pages/places"
import type { TopbarPeer } from "./topbar"

// --- Dashboard side of the Places page (#676) ---
//
// The owner's view of the places the Android shell turns into geofences,
// the reminders on them and the latest enter/exit events. Behind the same
// checks as every /api/admin route: the dashboard token when one is
// configured, and X-Requested-With from a same-origin page on a write.
//
//   GET  /places                                 the page
//   GET  /api/admin/places                       places, reminders, recent events
//   POST /api/admin/places                       { name, lat, lon, radiusMeters? }
//   POST /api/admin/places/update                { id, ... }
//   POST /api/admin/places/remove                { id }
//   POST /api/admin/places/reminders             { place, on, text, agent?, repeat? }
//   POST /api/admin/places/reminders/remove      { id }

export const PLACES_API = "/api/admin/places"

export interface PlacesPanelDeps {
  db: () => Database.Database | null
  settings: PlacesSettings
  peers?: TopbarPeer[]
  localToken?: string
}

export async function handlePlacesPanel(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: PlacesPanelDeps,
): Promise<boolean> {
  if (path !== "/places" && path !== PLACES_API && !path.startsWith(`${PLACES_API}/`)) return false
  const method = (req.method || "GET").toUpperCase()

  if (path === "/places") {
    if (method !== "GET") return sendJson(res, 405, { error: "GET only" })
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(renderPlacesPage({ peers: deps.peers, localToken: deps.localToken }))
    return true
  }
  if (method !== "GET" && req.headers["x-requested-with"] !== "agentx-board") {
    return sendJson(res, 400, { error: "missing X-Requested-With: agentx-board" })
  }
  const db = deps.db()
  if (!db) return sendJson(res, 503, { error: "The database could not be opened. Start the dashboard from the folder that holds agentx.json." })
  const store = new PlaceStore(db)
  const s = deps.settings

  if (method === "GET" && path === PLACES_API) {
    return sendJson(res, 200, { ...placesOverview(store, s), events: s.enabled ? store.recentEvents(20) : [] })
  }
  if (method !== "POST") return sendJson(res, 404, { error: "not found" })
  let body: Record<string, unknown>
  try { body = await readJson(req) } catch (e: any) { return sendJson(res, 400, { error: e.message }) }
  const answer: ApiAnswer | null =
    path === PLACES_API ? addPlace(store, s, body)
      : path === `${PLACES_API}/update` ? updatePlace(store, s, body)
        : path === `${PLACES_API}/remove` ? removePlace(store, body)
          : path === `${PLACES_API}/reminders` ? addReminder(store, s, body)
            : path === `${PLACES_API}/reminders/remove` ? removeReminder(store, body)
              : null
  if (!answer) return sendJson(res, 404, { error: "not found" })
  return sendJson(res, answer.status, answer.body)
}

/** The Digital Asset Links file that lets the Android shell open the phone
 *  app without an address bar. Null when no fingerprint is configured. */
export function assetLinks(s: PlacesSettings): unknown[] | null {
  if (!s.android.sha256CertFingerprints.length) return null
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: s.android.packageName,
      sha256_cert_fingerprints: s.android.sha256CertFingerprints.map((f) => f.toUpperCase()),
    },
  }]
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
