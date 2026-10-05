import type { IncomingMessage, ServerResponse } from "http"
import type { TokenRecord } from "./token-store"
import type { DaemonConfig } from "./config"
import { readJson } from "./app-fleet"
import {
  PlaceStore, parsePlaceEvent, parsePlaceInput, parseRuleInput, placesFile,
  type PlaceLimits,
} from "@/places/store"
import { fireRules, type FireDeps } from "@/places/fire"

// --- Places and place reminders (#676) ---
//
// The same routes serve two callers:
//
//   /api/app/places/*   the phone app and the Android app, behind the
//                       device-token check in app-routes.ts
//   /api/places/*       the dashboard's /places page, behind the
//                       dashboard's own gates (board-dashboard.ts)
//
//   GET  …                     places, reminders and limits
//   POST …/add                 { name, lat, lng, radius? }
//   POST …/remove              { id }      (and every reminder on it)
//   POST …/rules/add           { placeId, on, text, agent?, repeat? }
//   POST …/rules/enable        { id, enabled }
//   POST …/rules/remove        { id }
//   POST /api/app/places/event { id, place, transition, time }   phone only
//
// The event is all a phone ever sends about where it is: which saved place
// it crossed, which way, and when. Any other field in the body is ignored,
// and nothing about the event is kept beyond its id (to drop a retry).

export interface PlacesDeps {
  enabled: boolean
  limits: PlaceLimits
  syncMinutes: number
  store: PlaceStore
  /** Agents a reminder may hand a task to. */
  agents: () => string[]
  /** Null when this computer can't push (push disabled or relayed). */
  fire: FireDeps | null
  /** Why `fire` is null, for the phone to show. */
  pushReason?: string
  /** The Android app's package, for the phone app's "Open settings" link. */
  androidPackage: string
  log: (msg: string) => void
}

/** Handles /api/app/places* for a paired phone. */
export async function handleAppPlaces(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  device: TokenRecord,
  deps: PlacesDeps,
): Promise<boolean> {
  if (path !== "/api/app/places" && !path.startsWith("/api/app/places/")) return false
  return placesApi(req, res, path.slice("/api/app/places".length), method, deps, device)
}

/** Handles /api/places* for the dashboard page. */
export async function handleDashboardPlaces(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  deps: PlacesDeps,
): Promise<boolean> {
  if (path !== "/api/places" && !path.startsWith("/api/places/")) return false
  return placesApi(req, res, path.slice("/api/places".length), method, deps, null)
}

async function placesApi(
  req: IncomingMessage,
  res: ServerResponse,
  sub: string,
  method: string,
  deps: PlacesDeps,
  device: TokenRecord | null,
): Promise<true> {
  if (method === "GET" && sub === "") {
    const data = deps.enabled ? deps.store.read() : { places: [], rules: [] }
    return json(res, 200, {
      enabled: deps.enabled,
      reason: deps.enabled ? null : "Place reminders are off on this computer (app.places.enabled).",
      pushAvailable: !!deps.fire,
      pushReason: deps.fire ? null : deps.pushReason ?? null,
      limits: {
        defaultRadiusMeters: deps.limits.defaultRadiusMeters,
        minRadiusMeters: deps.limits.minRadiusMeters,
        maxRadiusMeters: deps.limits.maxRadiusMeters,
        maxPlaces: deps.limits.maxPlaces,
      },
      syncMinutes: deps.syncMinutes,
      android: { packageName: deps.androidPackage },
      places: data.places,
      rules: data.rules,
      agents: deps.agents(),
    })
  }
  if (method !== "POST") return json(res, 404, { error: "not found" })
  if (!deps.enabled) return json(res, 403, { error: "Place reminders are off on this computer (app.places.enabled)." })

  let body: Record<string, unknown>
  try { body = await readJson(req, 4096) } catch (e: any) { return json(res, 400, { error: e.message }) }

  if (sub === "/event") {
    if (!device) return json(res, 404, { error: "not found" })
    const ev = parsePlaceEvent(body)
    if (!ev.ok) return json(res, 400, { error: ev.error })
    const out = deps.store.accept(ev.value, deps.limits)
    // Ids and the direction only: never a name or a time of day in the log.
    deps.log(`[places] ${device.id} ${ev.value.transition} ${ev.value.place}: ${out.status}${out.status === "fired" ? ` (${out.rules.length})` : ""}`)
    if (out.status === "fired") {
      if (deps.fire) {
        void fireRules(device.id, out.place, out.rules, ev.value.time, deps.fire).catch((e) => deps.log(`[places] delivery failed: ${e?.message || e}`))
      } else {
        deps.log(`[places] ${out.rules.length} reminder(s) not sent: ${deps.pushReason ?? "this computer doesn't send pushes"}`)
      }
    }
    // 202 for every well-formed report, so the phone never retries one the
    // computer has already seen or chose to drop.
    return json(res, 202, { ok: true, status: out.status, fired: out.status === "fired" ? out.rules.length : 0 })
  }
  if (sub === "/add") {
    const p = parsePlaceInput(body, deps.limits)
    if (!p.ok) return json(res, 400, { error: p.error })
    const r = deps.store.addPlace(p.value, deps.limits)
    return r.ok ? json(res, 200, { ok: true, place: r.place }) : json(res, 409, { error: r.error })
  }
  if (sub === "/remove") {
    const id = typeof body.id === "string" ? body.id : ""
    return deps.store.removePlace(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "No such place." })
  }
  if (sub === "/rules/add") {
    const agents = new Set(deps.agents())
    const p = parseRuleInput(body, (id) => agents.has(id))
    if (!p.ok) return json(res, 400, { error: p.error })
    const r = deps.store.addRule(p.value, deps.limits)
    return r.ok ? json(res, 200, { ok: true, rule: r.rule }) : json(res, 409, { error: r.error })
  }
  if (sub === "/rules/enable") {
    if (typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled must be true or false" })
    const rule = deps.store.setRuleEnabled(typeof body.id === "string" ? body.id : "", body.enabled)
    return rule ? json(res, 200, { ok: true, rule }) : json(res, 404, { error: "No such reminder." })
  }
  if (sub === "/rules/remove") {
    const id = typeof body.id === "string" ? body.id : ""
    return deps.store.removeRule(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "No such reminder." })
  }
  return json(res, 404, { error: "not found" })
}

/** Built per request by the dashboard, so a config reload is picked up. */
export function placesDeps(config: DaemonConfig, root: string, fire: FireDeps | null, pushReason?: string): PlacesDeps {
  const s = config.app.places
  return {
    enabled: s.enabled,
    limits: s,
    syncMinutes: s.syncMinutes,
    store: new PlaceStore(placesFile(root, s.file)),
    agents: () => Object.keys(config.agents || {}).sort(),
    fire,
    pushReason,
    androidPackage: config.app.android.packageName,
    log: (msg) => console.error(msg),
  }
}

/** The Digital Asset Links statement that lets Chrome open the Android app
 *  full screen. Null (404) without fingerprints: there is nothing to vouch for. */
export function assetLinks(config: DaemonConfig): unknown[] | null {
  const a = config.app.android
  if (!a.certFingerprints.length) return null
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: a.packageName, sha256_cert_fingerprints: a.certFingerprints.map((f) => f.toUpperCase()) },
  }]
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
