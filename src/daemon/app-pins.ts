import type { IncomingMessage, ServerResponse } from "http"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, isAbsolute, resolve } from "path"
import { randomBytes } from "crypto"
import type { DaemonConfig } from "./config"
import { readJson } from "./app-fleet"

// --- Pinned pages in the phone app (#1120) ---
//
// The owner pins any https page (a tool on their tailnet, a status page) as
// a button in /app. Tapping it opens the page in the app's own window: a
// plain navigation, so the Android app keeps it inside its Chrome window and
// the back gesture returns to /app. The page itself is never fetched or
// proxied here; the computer only keeps the list.
//
//   GET  /api/app/pins           { pins, max }
//   POST /api/app/pins/add       { label, url }
//   POST /api/app/pins/rename    { id, label }
//   POST /api/app/pins/remove    { id }
//
// A pinned address can carry a secret (a key in its path), so the file is
// private to the owner, and neither the address nor the label is logged.

export interface Pin {
  id: string
  label: string
  url: string
  createdAt: string
}

/** The `app.pins` defaults, for `agentx app pin` run without agentx.json. */
export const DEFAULT_PINS_FILE = ".agentx/app-pins.json"
export const DEFAULT_PINS_MAX = 12
export const PIN_LABEL_MAX = 40
export const PIN_URL_MAX = 2000
const ID = /^pin_[a-z0-9]{6,32}$/

export function pinsFile(root: string, file: string): string {
  return isAbsolute(file) ? file : resolve(root, file)
}

export function parsePinLabel(v: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const label = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : ""
  if (!label) return { ok: false, error: "Give the button a name." }
  if ([...label].length > PIN_LABEL_MAX) return { ok: false, error: `Keep the name under ${PIN_LABEL_MAX} characters.` }
  return { ok: true, value: label }
}

/** Only https addresses with a host and no user name or password in them. */
export function parsePinUrl(v: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const raw = typeof v === "string" ? v.trim() : ""
  if (!raw) return { ok: false, error: "Give the page's address." }
  if (raw.length > PIN_URL_MAX) return { ok: false, error: `Keep the address under ${PIN_URL_MAX} characters.` }
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, error: "That is not a web address. It should start with https://" } }
  if (url.protocol !== "https:" || !url.hostname) return { ok: false, error: "Only https:// pages can be pinned." }
  if (url.username || url.password) return { ok: false, error: "Leave the user name and password out of the address." }
  return { ok: true, value: url.href }
}

export function parsePinInput(body: Record<string, unknown>): { ok: true; value: { label: string; url: string } } | { ok: false; error: string } {
  const label = parsePinLabel(body.label)
  if (!label.ok) return label
  const url = parsePinUrl(body.url)
  if (!url.ok) return url
  return { ok: true, value: { label: label.value, url: url.value } }
}

/** The pins, in the order they were added, in one small JSON file. */
export class PinStore {
  constructor(private path: string, private now: () => number = Date.now) {}

  list(): Pin[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8"))
      const pins: unknown[] = Array.isArray(raw?.pins) ? raw.pins : []
      return pins.filter((p): p is Pin => {
        const o = p as Pin
        return !!o && typeof o.id === "string" && ID.test(o.id) && parsePinLabel(o.label).ok && parsePinUrl(o.url).ok
      })
    } catch {
      return []
    }
  }

  private write(pins: Pin[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pins }, null, 2) + "\n", { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  add(input: { label: string; url: string }, max: number): { ok: true; pin: Pin } | { ok: false; error: string } {
    const pins = this.list()
    if (pins.length >= max) return { ok: false, error: `You already have ${max} pinned pages, the most allowed (app.pins.max). Remove one first.` }
    if (pins.some((p) => p.label.toLowerCase() === input.label.toLowerCase())) return { ok: false, error: `You already have a button called ${input.label}.` }
    const pin: Pin = { id: `pin_${randomBytes(6).toString("hex")}`, ...input, createdAt: new Date(this.now()).toISOString() }
    pins.push(pin)
    this.write(pins)
    return { ok: true, pin }
  }

  rename(id: string, label: string): { ok: true; pin: Pin } | { ok: false; status: 404 | 409; error: string } {
    const pins = this.list()
    const pin = pins.find((p) => p.id === id)
    if (!pin) return { ok: false, status: 404, error: "No such pinned page." }
    if (pins.some((p) => p.id !== id && p.label.toLowerCase() === label.toLowerCase())) return { ok: false, status: 409, error: `You already have a button called ${label}.` }
    pin.label = label
    this.write(pins)
    return { ok: true, pin }
  }

  remove(id: string): boolean {
    const pins = this.list()
    const left = pins.filter((p) => p.id !== id)
    if (left.length === pins.length) return false
    this.write(left)
    return true
  }
}

export interface PinsDeps {
  store: PinStore
  max: number
}

/** Built per request, so a config reload is picked up. */
export function pinsDeps(config: DaemonConfig, root: string): PinsDeps {
  const s = config.app.pins
  return { store: new PinStore(pinsFile(root, s.file)), max: s.max }
}

/** Handles /api/app/pins* for a paired phone. */
export async function handleAppPins(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  deps: PinsDeps,
): Promise<boolean> {
  if (path !== "/api/app/pins" && !path.startsWith("/api/app/pins/")) return false
  const sub = path.slice("/api/app/pins".length)
  if (method === "GET" && sub === "") return json(res, 200, { pins: deps.store.list(), max: deps.max })
  if (method !== "POST") return json(res, 404, { error: "not found" })

  let body: Record<string, unknown>
  try { body = await readJson(req, 4096) } catch (e: any) { return json(res, 400, { error: e.message }) }
  const id = typeof body.id === "string" ? body.id : ""

  if (sub === "/add") {
    const p = parsePinInput(body)
    if (!p.ok) return json(res, 400, { error: p.error })
    const r = deps.store.add(p.value, deps.max)
    return r.ok ? json(res, 200, { ok: true, pin: r.pin }) : json(res, 409, { error: r.error })
  }
  if (sub === "/rename") {
    const label = parsePinLabel(body.label)
    if (!label.ok) return json(res, 400, { error: label.error })
    const r = deps.store.rename(id, label.value)
    return r.ok ? json(res, 200, { ok: true, pin: r.pin }) : json(res, r.status, { error: r.error })
  }
  if (sub === "/remove") {
    return deps.store.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "No such pinned page." })
  }
  return json(res, 404, { error: "not found" })
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
