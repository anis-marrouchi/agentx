import type { IncomingMessage, ServerResponse } from "http"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, isAbsolute, resolve } from "path"
import { createHash, randomBytes } from "crypto"
import type { DaemonConfig } from "./config"
import { readJson } from "./app-fleet"
import { LockBusyError, withLock } from "@/wiki/facts/ledger-file"

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
//
// Pins also come from `app.pins.pages` in agentx.json (#1121): the same
// buttons on every phone, listed first and marked `source: "config"`. The
// phone and `agentx app` can't rename or remove those; agentx.json can.

export interface Pin {
  id: string
  label: string
  url: string
  /** Absent on pins from agentx.json. */
  createdAt?: string
  /** "config" for a pin from `app.pins.pages`; absent for the file's. */
  source?: "config"
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
  // No control or invisible format characters: `agentx app pins` prints
  // labels to a terminal.
  if (/[\p{Cc}\p{Cf}]/u.test(label)) return { ok: false, error: "Use only letters, numbers, spaces and punctuation in the name." }
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

/** Ids for agentx.json pins come from the address, so they stay the same
 *  across reloads and reordering. */
export function configPinId(url: string): string {
  return `cfg_${createHash("sha256").update(url).digest("hex").slice(0, 12)}`
}

/** The pins in `app.pins.pages`, in order. An entry that repeats an earlier
 *  address or name (any case) is left out. */
export function configPins(pages: { label: string; url: string }[]): Pin[] {
  const out: Pin[] = []
  for (const p of pages) {
    const label = parsePinLabel(p.label)
    const url = parsePinUrl(p.url)
    if (!label.ok || !url.ok) continue
    if (out.some((o) => o.url === url.value || o.label.toLowerCase() === label.value.toLowerCase())) continue
    out.push({ id: configPinId(url.value), label: label.value, url: url.value, source: "config" })
  }
  return out
}

const FROM_CONFIG = "This button is set in agentx.json (app.pins.pages). Change or remove it there."

export function parsePinInput(body: Record<string, unknown>): { ok: true; value: { label: string; url: string } } | { ok: false; error: string } {
  const label = parsePinLabel(body.label)
  if (!label.ok) return label
  const url = parsePinUrl(body.url)
  if (!url.ok) return url
  return { ok: true, value: { label: label.value, url: url.value } }
}

type Changed<T> = { ok: true } & T | { ok: false; status: 404 | 409; error: string }

/** The pins, in the order they were added, in one small JSON file.
 *
 *  A file that can't be read as pins (a hand edit gone wrong) is shown
 *  without the entries it can't use, but never written over: every change
 *  is refused until the file is fixed, so no pin is lost to a typo.
 *
 *  Each change reads and writes under `<file>.lock`, so the daemon (the
 *  phone's card) and `agentx app pin` (another process) can't drop each
 *  other's change.
 *
 *  `fixed` are the pins from agentx.json: listed first, counted toward the
 *  limit and the names in use, and never written to the file. */
export class PinStore {
  constructor(private path: string, private now: () => number = Date.now, private fixed: Pin[] = []) {}

  list(): Pin[] {
    return this.shown(this.load().pins)
  }

  /** The config pins, then the file's. A file pin whose name a config pin
   *  took later (the same page moved into agentx.json) is left out, so the
   *  row never shows two buttons with one name. */
  private shown(pins: Pin[]): Pin[] {
    const taken = new Set(this.fixed.map((p) => p.label.toLowerCase()))
    return [...this.fixed, ...pins.filter((p) => !taken.has(p.label.toLowerCase()))]
  }

  private isFixed(id: string): boolean {
    return this.fixed.some((p) => p.id === id)
  }

  private load(): { pins: Pin[]; damaged: boolean } {
    let text: string
    try { text = readFileSync(this.path, "utf-8") } catch (e: any) {
      return { pins: [], damaged: e?.code !== "ENOENT" }
    }
    let raw: any
    try { raw = JSON.parse(text) } catch { return { pins: [], damaged: true } }
    const all: unknown[] = Array.isArray(raw?.pins) ? raw.pins : []
    const pins = all.filter((p): p is Pin => {
      const o = p as Pin
      return !!o && typeof o.id === "string" && ID.test(o.id) && parsePinLabel(o.label).ok && parsePinUrl(o.url).ok
    })
    return { pins, damaged: !Array.isArray(raw?.pins) || pins.length !== all.length }
  }

  /** Runs one change under the file's lock; a lock held too long is a
   *  refusal, not a crash. */
  private locked<T>(fn: () => Changed<T>): Changed<T> {
    try {
      return withLock(this.path, fn, { what: "The pinned pages file" })
    } catch (e) {
      if (e instanceof LockBusyError) return { ok: false, status: 409, error: e.message }
      throw e
    }
  }

  /** The pins to change, or why they can't be changed. */
  private editable(): { ok: true; pins: Pin[] } | { ok: false; status: 409; error: string } {
    const { pins, damaged } = this.load()
    if (damaged) return { ok: false, status: 409, error: `The pinned pages file (${this.path}) can't be read. Fix or remove it on the computer, then try again.` }
    return { ok: true, pins }
  }

  private write(pins: Pin[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pins }, null, 2) + "\n", { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  add(input: { label: string; url: string }, max: number): Changed<{ pin: Pin }> {
    return this.locked(() => this.addUnlocked(input, max))
  }

  private addUnlocked(input: { label: string; url: string }, max: number): Changed<{ pin: Pin }> {
    const e = this.editable()
    if (!e.ok) return e
    const pins = e.pins
    if (this.shown(pins).length >= max) return { ok: false, status: 409, error: `You already have ${max} pinned pages, the most allowed (app.pins.max). Remove one first.` }
    if ([...this.fixed, ...pins].some((p) => p.label.toLowerCase() === input.label.toLowerCase())) return { ok: false, status: 409, error: `You already have a button called ${input.label}.` }
    const pin: Pin = { id: `pin_${randomBytes(6).toString("hex")}`, ...input, createdAt: new Date(this.now()).toISOString() }
    pins.push(pin)
    this.write(pins)
    return { ok: true, pin }
  }

  rename(id: string, label: string): Changed<{ pin: Pin }> {
    return this.locked(() => this.renameUnlocked(id, label))
  }

  private renameUnlocked(id: string, label: string): Changed<{ pin: Pin }> {
    if (this.isFixed(id)) return { ok: false, status: 409, error: FROM_CONFIG }
    const e = this.editable()
    if (!e.ok) return e
    const pins = e.pins
    const pin = pins.find((p) => p.id === id)
    if (!pin) return { ok: false, status: 404, error: "No such pinned page." }
    if ([...this.fixed, ...pins].some((p) => p.id !== id && p.label.toLowerCase() === label.toLowerCase())) return { ok: false, status: 409, error: `You already have a button called ${label}.` }
    pin.label = label
    this.write(pins)
    return { ok: true, pin }
  }

  remove(id: string): Changed<{}> {
    return this.locked(() => this.removeUnlocked(id))
  }

  private removeUnlocked(id: string): Changed<{}> {
    if (this.isFixed(id)) return { ok: false, status: 409, error: FROM_CONFIG }
    const e = this.editable()
    if (!e.ok) return e
    const left = e.pins.filter((p) => p.id !== id)
    if (left.length === e.pins.length) return { ok: false, status: 404, error: "No such pinned page." }
    this.write(left)
    return { ok: true }
  }
}

export interface PinsDeps {
  store: PinStore
  max: number
}

/** Built per request, so a config reload is picked up. */
export function pinsDeps(config: DaemonConfig, root: string): PinsDeps {
  const s = config.app.pins
  return { store: new PinStore(pinsFile(root, s.file), Date.now, configPins(s.pages)), max: s.max }
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
    return r.ok ? json(res, 200, { ok: true, pin: r.pin }) : json(res, r.status, { error: r.error })
  }
  if (sub === "/rename") {
    const label = parsePinLabel(body.label)
    if (!label.ok) return json(res, 400, { error: label.error })
    const r = deps.store.rename(id, label.value)
    return r.ok ? json(res, 200, { ok: true, pin: r.pin }) : json(res, r.status, { error: r.error })
  }
  if (sub === "/remove") {
    const r = deps.store.remove(id)
    return r.ok ? json(res, 200, { ok: true }) : json(res, r.status, { error: r.error })
  }
  return json(res, 404, { error: "not found" })
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
