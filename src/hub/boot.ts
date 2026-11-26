// --- What the daemon's /hub document hands the app (#2218) ---
//
// The daemon still answers /hub (theme boot, pageAllowed(), AX_LOCAL_TOKEN);
// with the React switch on it adds `window.AX_HUB` and the app's entry
// script (src/daemon/ui/hub-react.ts).

import { resolveHubLayout, type HubLayoutSetting, type HubLayoutView } from "./layout"

export interface HubBoot {
  /** React page ids for this viewer (src/hub/pages.ts, minus legacyPages). */
  pages: string[]
  owner: boolean
  /** Simple or full, and each item shown or not (#2226 S1, layout.ts):
   *  the same dashboard.hub keys the old Hub reads. */
  layout: HubLayoutView
}

declare global {
  interface Window {
    AX_HUB?: Partial<Omit<HubBoot, "layout">> & { layout?: HubLayoutSetting }
    AX_LOCAL_TOKEN?: string
    /** The hash /hub was opened with, before any script changed it (hub-react.ts). */
    AX_HUB_HASH?: string
  }
}

export function readBoot(w: Pick<Window, "AX_HUB"> = window): HubBoot {
  const b = w.AX_HUB || {}
  return { pages: Array.isArray(b.pages) ? b.pages.filter((p) => typeof p === "string") : [], owner: !!b.owner, layout: resolveHubLayout(b.layout) }
}
