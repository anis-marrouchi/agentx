import type { IncomingMessage, ServerResponse } from "http"
import type { DaemonConfig } from "./config"
import { readJson } from "./app-fleet"
import { configPins, pinsDeps, type Pin } from "./app-pins"
import { MENU_BAR_MAX, MENU_ITEMS_MAX, MENU_PRESETS, MENU_PRESET_IDS, MenuStore, menuFile, type MenuCatalog } from "./hub-menu"

// --- The Hub's menu, over HTTP (#2149, M1) ---
//
// Owner only. The routes sit under the Wall's prefix, so the Wall's owner
// guard (#1454, isWallWrite) already stops a write without the owner's
// token; the GET is checked by the caller (isDashboardOwner).
//
//   GET  /api/admin/wall/menu        { menu, saved, damaged, catalog, presets, fixedLinks, limits }
//   POST /api/admin/wall/menu        { revision, items, bar }  the whole list
//   POST /api/admin/wall/menu/reset  { revision, preset }
//   POST /api/admin/wall/menu/used   { id }  at most one write per item a day
//
// A save or reset that names an older revision gets 409: reload and redo.

export const HUB_MENU_PATH = "/api/admin/wall/menu"

export function isHubMenuPath(path: string): boolean {
  return path === HUB_MENU_PATH || path === `${HUB_MENU_PATH}/reset` || path === `${HUB_MENU_PATH}/used`
}

export interface HubMenuDeps {
  store: MenuStore
  catalog: MenuCatalog
  /** Links set in agentx.json (app.pins.pages): shown first, read only. */
  fixedLinks: Pin[]
  pinsMax: number
}

/** Built per request, so a config reload is picked up. */
export function hubMenuDeps(config: DaemonConfig, root: string, catalog: MenuCatalog): HubMenuDeps {
  const pins = pinsDeps(config, root)
  return {
    store: new MenuStore(menuFile(root), catalog, pins.store, pins.max),
    catalog,
    fixedLinks: configPins(config.app.pins.pages),
    pinsMax: pins.max,
  }
}

export async function handleHubMenu(req: IncomingMessage, res: ServerResponse, path: string, method: string, deps: HubMenuDeps): Promise<boolean> {
  if (!isHubMenuPath(path)) return false
  if (method === "GET" && path === HUB_MENU_PATH) {
    const r = deps.store.read()
    return json(res, 200, {
      menu: r.menu,
      saved: r.saved,
      damaged: r.damaged,
      catalog: deps.catalog,
      presets: MENU_PRESET_IDS.map((id) => ({ id, label: MENU_PRESETS[id].label })),
      fixedLinks: deps.fixedLinks,
      limits: { items: MENU_ITEMS_MAX, bar: MENU_BAR_MAX, links: deps.pinsMax },
    })
  }
  if (method !== "POST") return json(res, 405, { error: "method not allowed" })
  let body: Record<string, unknown>
  try { body = await readJson(req, 64 * 1024) } catch (e: any) { return json(res, 400, { error: e.message }) }
  const r = path === HUB_MENU_PATH ? deps.store.save(body)
    : path.endsWith("/reset") ? deps.store.reset(body)
    : deps.store.used(body.id)
  return r.ok ? json(res, 200, { ok: true, menu: r.menu }) : json(res, r.status, { error: r.error })
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
