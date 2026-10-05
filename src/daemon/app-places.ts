import type { IncomingMessage, ServerResponse } from "http"
import type { TokenRecord } from "./token-store"
import type { DaemonConfig } from "./config"
import { readJson } from "./app-fleet"
import { APP_SENDER } from "./app-chat-relay"
import { PlaceStore } from "@/places/store"
import { receivePlaceEvent, type PlaceDelivery } from "@/places/events"
import {
  PLACES_OFF, addPlace, addReminder, placesOverview, removePlace, removeReminder, updatePlace,
  type ApiAnswer, type PlacesSettings,
} from "@/places/api"

// --- Phone app: places and place reminders (/api/app/places*) (#676) ---
//
// Runs behind the device-token check in app-routes.ts.
//
//   GET  /api/app/places                   places, reminders, settings
//   POST /api/app/places                   { name, lat, lon, radiusMeters? }
//   POST /api/app/places/update            { id, name?, lat?, lon?, radiusMeters? }
//   POST /api/app/places/remove            { id }
//   POST /api/app/places/reminders         { place, on, text, agent?, repeat?, thisPhone? }
//   POST /api/app/places/reminders/remove  { id }
//   POST /api/app/places/events            { id, place, transition, at }
//
// The Android shell reads the list and registers each place as a geofence,
// then posts an event when the phone enters or leaves one. The event holds
// a place id, a direction and a time: no coordinates ever come back.

export interface AppPlacesDeps {
  /** Null when the database is unavailable. */
  store: () => PlaceStore | null
  settings: PlacesSettings
  delivery: PlaceDelivery
  /** Called with each event's delivery, which runs after the answer (tests wait on it). */
  delivering?: (p: Promise<void>) => void
}

export async function handleAppPlaces(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  device: TokenRecord,
  deps: AppPlacesDeps,
): Promise<boolean> {
  if (path !== "/api/app/places" && !path.startsWith("/api/app/places/")) return false
  const store = deps.store()
  if (!store) return json(res, 503, { error: "The database on this computer is unavailable, so places can't be saved." })
  const s = deps.settings

  if (method === "GET" && path === "/api/app/places") {
    const events = s.enabled ? store.recentEvents(20).filter((e) => e.deviceId === device.id).slice(0, 5) : []
    return json(res, 200, { ...placesOverview(store, s), events })
  }
  if (method !== "POST") return json(res, 404, { error: "not found" })

  let body: Record<string, unknown>
  try { body = await readJson(req) } catch (e: any) { return json(res, 400, { error: e.message }) }

  if (path === "/api/app/places/events") {
    if (!s.enabled) return json(res, 409, { error: PLACES_OFF, enabled: false })
    const r = receivePlaceEvent(store, device.id, body, s, deps.delivery)
    if (r.status !== 200) return json(res, r.status, { error: r.error })
    deps.delivering?.(r.delivered)
    r.delivered.catch(() => {})
    return json(res, 200, { ok: true, fired: r.fired, ...(r.duplicate ? { duplicate: true } : {}), ...(r.note ? { note: r.note } : {}) })
  }
  const answer: ApiAnswer | null =
    path === "/api/app/places" ? addPlace(store, s, body)
      : path === "/api/app/places/update" ? updatePlace(store, s, body)
        : path === "/api/app/places/remove" ? removePlace(store, body)
          : path === "/api/app/places/reminders" ? addReminder(store, s, body, body.thisPhone === true ? device.id : null)
            : path === "/api/app/places/reminders/remove" ? removeReminder(store, body)
              : null
  if (!answer) return json(res, 404, { error: "not found" })
  return json(res, answer.status, answer.body)
}

/** Built per request by the dashboard, so a config reload is picked up.
 *  Notifications go out through the daemon's push channel (POST
 *  /channel/send, addressed to the phone that reported the event), as the
 *  chat finish alerts do; an agent reminder is a /task turn first. */
export function appPlacesDeps(
  config: DaemonConfig,
  db: () => ConstructorParameters<typeof PlaceStore>[0] | null,
  daemon: { url: string; token?: string; operatorKey?: string },
): AppPlacesDeps {
  const auth: Record<string, string> = daemon.token ? { Authorization: `Bearer ${daemon.token}` } : {}
  const post = async (path: string, body: unknown, timeoutMs: number) => {
    const r = await fetch(daemon.url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth, ...(daemon.operatorKey ? { "X-AgentX-Operator": daemon.operatorKey } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`)
    try { return JSON.parse(text) as Record<string, unknown> } catch { return { content: text } }
  }
  return {
    store: () => {
      const d = db()
      return d ? new PlaceStore(d) : null
    },
    settings: config.places,
    delivery: {
      push: async (deviceId, title, body) => {
        // First line is the title; the button is where a tap lands.
        await post("/channel/send", { channel: "push", chatId: deviceId, text: `${title}\n${body}`, buttons: [{ label: "Open", url: "/app#alerts" }] }, 10_000)
      },
      ask: async (agent, prompt) => {
        const out = await post("/task", {
          agent,
          message: prompt,
          context: { channel: "app", chatId: "places", sender: APP_SENDER },
        }, config.places.agentTimeoutSeconds * 1000)
        if (typeof out.error === "string" && out.error) throw new Error(out.error)
        return typeof out.content === "string" ? out.content : ""
      },
      log: (line) => console.error(line),
    },
  }
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
