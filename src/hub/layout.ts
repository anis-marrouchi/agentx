// --- The Hub's layout: simple by default, full as an option (#2226 S1) ---
//
// One config block, read by the current Hub (src/daemon/ui/pages/hub-layout.ts)
// and handed to the React app in `window.AX_HUB.layout` (src/hub/boot.ts):
//
//   "dashboard": { "hub": { "layout": "simple" | "full",
//                           "show": { "<item>": true | false } } }
//
// `layout` sets every item's default: simple hides them all, full shows
// them all. `show.<item>` overrides that default for one item. No key at all
// (a new install, or one from before this change) is the simple layout.
//
// Hide, never disable: a hidden item keeps running (schedules, gates and
// workflows still run, a hidden page still opens from a link); only its
// place on screen goes. A hidden owner gate still shows in Waiting on you.
//
// Plain data only: the daemon imports this file, so it must not import React
// or anything from the browser app (as pages.ts).

export const HUB_LAYOUTS = ["simple", "full"] as const
export type HubLayout = (typeof HUB_LAYOUTS)[number]
export const HUB_DEFAULT_LAYOUT: HubLayout = "simple"

export interface HubShowItemDef {
  /** The key under `dashboard.hub.show`. */
  id: string
  /** Its switch's name in Settings › Layout. */
  label: string
  /** What turning it on shows. */
  hint: string
  /** No place on screen in either Hub yet: the key stays (saved settings
   *  still load) but Settings › Layout draws no switch for it. */
  noPlace?: true
}

/** Every item the simple layout hides, in the order Settings lists them. */
export const HUB_SHOW_ITEMS = [
  { id: "mobile", label: "Mobile app page", hint: "The Mobile app link at the bottom of the side menu, with how to put the Hub on your phone." },
  { id: "workflows", label: "Workflows page", hint: "Workflows at the bottom of the side menu and in ⌘K. Workflows run either way." },
  { id: "wiki", label: "Wiki", hint: "The Wiki in the Hub's menus. The wiki and its schedules keep working either way." },
  // No Rules page yet, so its switch did nothing (#2313 review, E6). The
  // switch comes back with the Rules page: drop noPlace then.
  { id: "rules", label: "Rules", hint: "Rules in the Hub's menus. Rules apply either way.", noPlace: true },
  { id: "gates", label: "Plan gates and request steps", hint: "A post's steps (Asked, Working, Waits, Done), its plan and its gates. Gates still run, and one waiting on you is still in Waiting on you." },
  { id: "hosts", label: "Hosts and ports in the status bar", hint: "The machines this Hub reads, at the left of the bottom bar." },
  { id: "activity", label: "Activity page", hint: "Activity in ⌘K and the phone's More: every run, newest first." },
  { id: "org", label: "Org page", hint: "Org in ⌘K and the phone's More: the org chart." },
  { id: "sessions", label: "Live page", hint: "Live in ⌘K and the phone's More: the live sessions on every machine." },
  { id: "usage", label: "Cost page", hint: "Cost in ⌘K and the phone's More. The usage limits stay in the status bar either way." },
] as const satisfies readonly HubShowItemDef[]

export type HubShowItem = (typeof HUB_SHOW_ITEMS)[number]["id"]
export const HUB_SHOW_IDS: readonly HubShowItem[] = HUB_SHOW_ITEMS.map((i) => i.id)
/** The items Settings › Layout draws a switch for: every item with a place
 *  on screen. */
export const HUB_SWITCH_ITEMS: readonly HubShowItemDef[] = HUB_SHOW_ITEMS.filter((i: HubShowItemDef) => !i.noPlace)

/** `dashboard.hub` as agentx.json may hold it: any of the keys, or none. */
export interface HubLayoutSetting {
  layout?: string
  show?: Partial<Record<string, boolean | undefined>>
}

/** What the Hub draws: the layout, and every item shown or not. */
export interface HubLayoutView {
  layout: HubLayout
  show: Record<HubShowItem, boolean>
  /** The items with their own switch set, that the layout does not decide. */
  overrides: HubShowItem[]
}

export function isHubLayout(v: unknown): v is HubLayout {
  return typeof v === "string" && (HUB_LAYOUTS as readonly string[]).includes(v)
}

export function isHubShowItem(v: unknown): v is HubShowItem {
  return typeof v === "string" && (HUB_SHOW_IDS as readonly string[]).includes(v)
}

/** The layout this setting gives: simple unless it says full; each item
 *  its own switch when set, else the layout's default. */
export function resolveHubLayout(setting?: HubLayoutSetting | null): HubLayoutView {
  const layout: HubLayout = isHubLayout(setting?.layout) ? setting!.layout as HubLayout : HUB_DEFAULT_LAYOUT
  const show = {} as Record<HubShowItem, boolean>
  const overrides: HubShowItem[] = []
  for (const id of HUB_SHOW_IDS) {
    const own = setting?.show?.[id]
    if (typeof own === "boolean") overrides.push(id)
    show[id] = typeof own === "boolean" ? own : layout === "full"
  }
  return { layout, show, overrides }
}

/** The keys that give this view back (resolveHubLayout of it is the same
 *  view): the layout and only the items' own switches. What the page boot
 *  hands the browser. */
export function hubLayoutSetting(view: HubLayoutView): { layout: HubLayout; show: Partial<Record<HubShowItem, boolean>> } {
  const show: Partial<Record<HubShowItem, boolean>> = {}
  for (const id of view.overrides) show[id] = view.show[id]
  return { layout: view.layout, show }
}

/** The items this view hides, in Settings order. */
export function hubHiddenItems(view: HubLayoutView): HubShowItem[] {
  return HUB_SHOW_IDS.filter((id) => !view.show[id])
}

/** A change from Settings › Layout: a layout, or one item's switch. */
export interface HubLayoutPatch {
  layout?: HubLayout
  /** true / false: that item's own switch; null: back to the layout's default. */
  show?: Partial<Record<HubShowItem, boolean | null>>
}

/** Reads a Settings body into a patch; throws a plain sentence on a bad one. */
export function parseHubLayoutPatch(body: unknown): HubLayoutPatch {
  if (!body || typeof body !== "object") throw new Error("nothing to change")
  const b = body as Record<string, unknown>
  const out: HubLayoutPatch = {}
  if ("layout" in b) {
    if (!isHubLayout(b.layout)) throw new Error(`layout must be ${HUB_LAYOUTS.map((l) => `"${l}"`).join(" or ")}`)
    out.layout = b.layout
  }
  if ("show" in b) {
    if (!b.show || typeof b.show !== "object" || Array.isArray(b.show)) throw new Error("show must be an object of item: true or false")
    out.show = {}
    for (const [k, v] of Object.entries(b.show as Record<string, unknown>)) {
      if (!isHubShowItem(k)) throw new Error(`"${k}" is not a Hub item; one of ${HUB_SHOW_IDS.join(", ")}`)
      if (v !== null && typeof v !== "boolean") throw new Error(`show.${k} must be true, false or null`)
      out.show[k] = v as boolean | null
    }
  }
  if (!out.layout && !out.show) throw new Error("nothing to change: send layout or show")
  return out
}

/** Applies a patch to agentx.json's object in place and says what changed.
 *  Picking a layout clears the items' own switches, so Full shows everything
 *  and Simple hides everything; an item's switch then overrides it. */
export function applyHubLayoutPatch(cfg: Record<string, any>, patch: HubLayoutPatch): string {
  cfg.dashboard = cfg.dashboard && typeof cfg.dashboard === "object" ? cfg.dashboard : {}
  const hub = cfg.dashboard.hub && typeof cfg.dashboard.hub === "object" ? cfg.dashboard.hub : {}
  cfg.dashboard.hub = hub
  const said: string[] = []
  if (patch.layout) {
    hub.layout = patch.layout
    delete hub.show
    said.push(`Hub layout: ${patch.layout}`)
  }
  for (const [k, v] of Object.entries(patch.show ?? {})) {
    hub.show = hub.show && typeof hub.show === "object" ? hub.show : {}
    if (v === null || v === undefined) { delete hub.show[k]; said.push(`${k}: as the layout`) }
    else { hub.show[k] = v; said.push(`${k}: ${v ? "shown" : "hidden"}`) }
  }
  if (hub.show && !Object.keys(hub.show).length) delete hub.show
  return said.join(", ")
}
