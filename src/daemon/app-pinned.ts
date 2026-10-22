import type { IncomingMessage, ServerResponse } from "http"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, isAbsolute, resolve } from "path"
import { createHash, randomBytes } from "crypto"
import type { DaemonConfig } from "./config"
import { readJson } from "./app-fleet"

// --- Pinned pages: web pages shown as buttons in the phone app (#1120) ---
//
// A pinned page is a label and an https address, for example a tool page
// served elsewhere on the owner's tailnet. The phone app shows each one as a
// button under its header; tapping it opens the page inside the app (in the
// Android app, Chrome shows it in the app's own window), so the page's own
// microphone and camera prompts work as in Chrome.
//
// Pages come from two places:
//
//   app.pinned.pages in agentx.json   read only here; edit agentx.json
//   the phone app's Pinned pages card kept in app.pinned.file
//
//   GET  /api/app/pinned          { enabled, max, pages: [{ id, label, url, source }] }
//   POST /api/app/pinned/add      { label, url }
//   POST /api/app/pinned/rename   { id, label }
//   POST /api/app/pinned/remove   { id }
//
// Only https is accepted: a page needs a secure origin for the microphone,
// and a plain http page would send the tap's address in clear. AgentX never
// fetches the page; it only hands the address to the phone.

export const PIN_LABEL_MAX = 40
export const PIN_URL_MAX = 2048
const ID = /^(pin|cfg)_[a-f0-9]{6,32}$/

export interface PinnedPage {
  id: string
  label: string
  url: string
  createdAt?: string
}

export interface PinnedView extends PinnedPage {
  source: "config" | "app"
}

/** Validates a label. Shared by add and rename. */
export function parsePinLabel(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const label = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : ""
  if (!label) return { ok: false, error: "Give the button a name." }
  if ([...label].length > PIN_LABEL_MAX) return { ok: false, error: `Keep the name under ${PIN_LABEL_MAX} characters.` }
  return { ok: true, value: label }
}

/** Validates an address: https, a host, no user name or password in it. */
export function parsePinUrl(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.trim() : ""
  if (!text) return { ok: false, error: "Type the page's address." }
  if (text.length > PIN_URL_MAX) return { ok: false, error: `Keep the address under ${PIN_URL_MAX} characters.` }
  let u: URL
  try { u = new URL(text) } catch { return { ok: false, error: "That is not a web address. It starts with https://" } }
  if (u.protocol !== "https:") return { ok: false, error: "The address must start with https:// (the microphone only works on https pages)." }
  if (!u.hostname) return { ok: false, error: "The address has no host." }
  if (u.username || u.password) return { ok: false, error: "Leave the user name and password out of the address." }
  return { ok: true, value: u.href }
}

/** Ids for config pages come from the address, so they stay put across
 *  reloads and reordering. */
export function configPinId(url: string): string {
  return `cfg_${createHash("sha256").update(url).digest("hex").slice(0, 12)}`
}

export function configPins(pages: { label: string; url: string }[]): PinnedPage[] {
  const out: PinnedPage[] = []
  const seen = new Set<string>()
  for (const p of pages) {
    const label = parsePinLabel(p.label)
    const url = parsePinUrl(p.url)
    if (!label.ok || !url.ok) continue
    const id = configPinId(url.value)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: label.value, url: url.value })
  }
  return out
}

export class PinnedStore {
  constructor(private path: string, private now: () => number = Date.now) {}

  read(): PinnedPage[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8"))
      const pages: unknown[] = Array.isArray(raw?.pages) ? raw.pages : []
      return pages.filter((p): p is PinnedPage => !!p && typeof p === "object"
        && typeof (p as PinnedPage).id === "string" && typeof (p as PinnedPage).label === "string" && typeof (p as PinnedPage).url === "string")
    } catch {
      return []
    }
  }

  private write(pages: PinnedPage[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pages }, null, 2) + "\n", { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  add(label: string, url: string, max: number, taken: number): { ok: true; page: PinnedPage } | { ok: false; error: string } {
    const pages = this.read()
    if (pages.length + taken >= max) return { ok: false, error: `You already have ${max} pinned pages, the most allowed (app.pinned.max). Remove one first.` }
    if (pages.some((p) => p.url === url)) return { ok: false, error: "That page is already pinned." }
    const page: PinnedPage = { id: `pin_${randomBytes(6).toString("hex")}`, label, url, createdAt: new Date(this.now()).toISOString() }
    pages.push(page)
    this.write(pages)
    return { ok: true, page }
  }

  rename(id: string, label: string): PinnedPage | null {
    const pages = this.read()
    const page = pages.find((p) => p.id === id)
    if (!page) return null
    page.label = label
    this.write(pages)
    return page
  }

  remove(id: string): boolean {
    const pages = this.read()
    const left = pages.filter((p) => p.id !== id)
    if (left.length === pages.length) return false
    this.write(left)
    return true
  }
}

export interface PinnedDeps {
  enabled: boolean
  max: number
  /** Pages from app.pinned.pages, already validated. */
  config: PinnedPage[]
  store: PinnedStore
}

/** Handles /api/app/pinned* for a paired phone. */
export async function handleAppPinned(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  deps: PinnedDeps,
): Promise<boolean> {
  if (path !== "/api/app/pinned" && !path.startsWith("/api/app/pinned/")) return false
  const sub = path.slice("/api/app/pinned".length)
  const off = "Pinned pages are off on this computer (app.pinned.enabled)."

  if (method === "GET" && sub === "") {
    if (!deps.enabled) return json(res, 200, { enabled: false, reason: off, max: deps.max, pages: [] })
    const config = new Set(deps.config.map((p) => p.url))
    const pages: PinnedView[] = [
      ...deps.config.map((p) => ({ ...p, source: "config" as const })),
      // A page pinned in the app and later added to agentx.json shows once.
      ...deps.store.read().filter((p) => !config.has(p.url)).map((p) => ({ ...p, source: "app" as const })),
    ].slice(0, deps.max)
    return json(res, 200, { enabled: true, reason: null, max: deps.max, pages })
  }
  if (method !== "POST") return json(res, 404, { error: "not found" })
  if (!deps.enabled) return json(res, 403, { error: off })

  let body: Record<string, unknown>
  try { body = await readJson(req, 4096) } catch (e: any) { return json(res, 400, { error: e.message }) }
  const id = typeof body.id === "string" ? body.id : ""
  const fromConfig = id.startsWith("cfg_") && deps.config.some((p) => p.id === id)
  const configOnly = "This page is set in agentx.json (app.pinned.pages). Change or remove it there."

  if (sub === "/add") {
    const label = parsePinLabel(body.label)
    if (!label.ok) return json(res, 400, { error: label.error })
    const url = parsePinUrl(body.url)
    if (!url.ok) return json(res, 400, { error: url.error })
    if (deps.config.some((p) => p.url === url.value)) return json(res, 409, { error: "That page is already pinned." })
    const r = deps.store.add(label.value, url.value, deps.max, deps.config.length)
    return r.ok ? json(res, 200, { ok: true, page: { ...r.page, source: "app" } }) : json(res, 409, { error: r.error })
  }
  if (sub === "/rename") {
    if (fromConfig) return json(res, 409, { error: configOnly })
    if (!ID.test(id)) return json(res, 404, { error: "No such pinned page." })
    const label = parsePinLabel(body.label)
    if (!label.ok) return json(res, 400, { error: label.error })
    const page = deps.store.rename(id, label.value)
    return page ? json(res, 200, { ok: true, page: { ...page, source: "app" } }) : json(res, 404, { error: "No such pinned page." })
  }
  if (sub === "/remove") {
    if (fromConfig) return json(res, 409, { error: configOnly })
    return deps.store.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "No such pinned page." })
  }
  return json(res, 404, { error: "not found" })
}

/** Built per request by the dashboard, so a config reload is picked up. */
export function pinnedDeps(config: DaemonConfig, root: string): PinnedDeps {
  const s = config.app.pinned
  return {
    enabled: s.enabled,
    max: s.max,
    config: configPins(s.pages),
    store: new PinnedStore(isAbsolute(s.file) ? s.file : resolve(root, s.file)),
  }
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
