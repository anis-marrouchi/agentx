// --- The Hub's one extension registry (#2218 part 2) ---
//
// Every page, nav item, right-panel tab, Desk card, ⌘K command and settings
// section of the React Hub is added through defineHubExtension(). Built-in
// pages use the same call a plugin will use later (decision D2), so there is
// one way in, exercised every day.
//
// The shell only reads the tables below: the router reads `routes`, the left
// column and the bottom bar will read `nav`, the right panel `panelTabs`, the
// Desk `deskCards`. No page draws another page's nav or tab.

import type { ComponentType, LazyExoticComponent } from "react"
import { lazy } from "react"
import { HUB_REACT_PAGES } from "./pages"

/** A module whose default export is a component, as `import("./X")` gives. */
export type Loader<P = {}> = () => Promise<{ default: ComponentType<P> }>

export interface HubRoute {
  /** The `#page=` id. Must be listed in pages.ts (HUB_REACT_PAGES). */
  page: string
  title: string
  load: Loader<HubPageProps>
  /** Drawn while `load` runs: the page's own skeleton, in the main bundle,
   *  so the page takes the same space when it arrives (no jump). */
  fallback?: ComponentType
}

export interface HubPageProps {
  /** The hash's key=value pairs, `page` included. */
  params: URLSearchParams
}

export interface HubNavItem {
  id: string
  /** Where it sits: the agents list, the main places, or the foot. */
  group: "agents" | "places" | "foot"
  label: string
  /** An icon name from src/hub/ui/icons (added with the left column, step 3). */
  icon: string
  page: string
  ownerOnly?: boolean
  hiddenOnPhone?: boolean
  /** Lower first; equal orders keep the order they were defined in. */
  order?: number
}

export interface HubPanelTab {
  kind: string
  label: string
  /** The pages it can open beside. */
  opensFor: string[]
  load: Loader<{ params: URLSearchParams }>
}

export interface HubDeskCard {
  /** The card kind the server sends. An unknown kind gets the generic card. */
  kind: string
  load: Loader<{ card: unknown }>
}

export interface HubCommand {
  id: string
  label: string
  run: () => void
  ownerOnly?: boolean
}

export interface HubSettingsSection {
  id: string
  label: string
  load: Loader<{}>
}

export interface HubExtension {
  id: string
  routes?: HubRoute[]
  nav?: HubNavItem[]
  panelTabs?: HubPanelTab[]
  deskCards?: HubDeskCard[]
  commands?: HubCommand[]
  settings?: HubSettingsSection[]
}

export class HubRegistry {
  private readonly extensions = new Map<string, HubExtension>()
  private readonly lazyPages = new Map<string, LazyExoticComponent<ComponentType<HubPageProps>>>()

  /** Adds an extension. Throws on a second extension with the same id, a
   *  page id two extensions claim, or a page pages.ts does not list. */
  define(ext: HubExtension): HubExtension {
    if (!ext.id) throw new Error("hub extension: id is required")
    if (this.extensions.has(ext.id)) throw new Error(`hub extension "${ext.id}" is defined twice`)
    const known = new Set(HUB_REACT_PAGES.map((p) => p.page))
    for (const r of ext.routes ?? []) {
      if (!known.has(r.page)) throw new Error(`hub extension "${ext.id}": page "${r.page}" is not in src/hub/pages.ts`)
      if (this.route(r.page)) throw new Error(`hub extension "${ext.id}": page "${r.page}" is already taken`)
    }
    for (const c of ext.deskCards ?? []) {
      if (this.deskCard(c.kind)) throw new Error(`hub extension "${ext.id}": desk card "${c.kind}" is already taken`)
    }
    this.extensions.set(ext.id, ext)
    return ext
  }

  private all<T>(pick: (ext: HubExtension) => T[] | undefined): T[] {
    const out: T[] = []
    for (const ext of this.extensions.values()) out.push(...(pick(ext) ?? []))
    return out
  }

  routes(): HubRoute[] { return this.all((e) => e.routes) }
  route(page: string): HubRoute | undefined { return this.routes().find((r) => r.page === page) }

  /** The page's lazy component, made once so React keeps its state. */
  pageComponent(page: string): LazyExoticComponent<ComponentType<HubPageProps>> | undefined {
    const hit = this.lazyPages.get(page)
    if (hit) return hit
    const r = this.route(page)
    if (!r) return undefined
    const c = lazy(r.load)
    this.lazyPages.set(page, c)
    return c
  }

  /** Nav items for this viewer, in order. */
  nav(opts: { owner: boolean; phone?: boolean }): HubNavItem[] {
    return this.all((e) => e.nav)
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => (opts.owner || !item.ownerOnly) && !(opts.phone && item.hiddenOnPhone))
      .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.i - b.i)
      .map(({ item }) => item)
  }

  panelTabs(page: string): HubPanelTab[] { return this.all((e) => e.panelTabs).filter((t) => t.opensFor.includes(page)) }
  deskCard(kind: string): HubDeskCard | undefined { return this.all((e) => e.deskCards).find((c) => c.kind === kind) }
  commands(opts: { owner: boolean }): HubCommand[] { return this.all((e) => e.commands).filter((c) => opts.owner || !c.ownerOnly) }
  settings(): HubSettingsSection[] { return this.all((e) => e.settings) }
}

/** The app's registry. */
export const hubRegistry = new HubRegistry()

/** The one call built-in pages and (later) plugins use. */
export function defineHubExtension(ext: HubExtension): HubExtension {
  return hubRegistry.define(ext)
}
