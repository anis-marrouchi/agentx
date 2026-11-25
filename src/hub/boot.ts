// --- What the daemon's /hub document hands the app (#2218) ---
//
// The daemon still answers /hub (theme boot, pageAllowed(), AX_LOCAL_TOKEN);
// with the React switch on it adds `window.AX_HUB` and the app's entry
// script (src/daemon/ui/hub-react.ts).

export interface HubBoot {
  /** React page ids for this viewer (src/hub/pages.ts, minus legacyPages). */
  pages: string[]
  owner: boolean
}

declare global {
  interface Window {
    AX_HUB?: Partial<HubBoot>
    AX_LOCAL_TOKEN?: string
  }
}

export function readBoot(w: Pick<Window, "AX_HUB"> = window): HubBoot {
  const b = w.AX_HUB || {}
  return { pages: Array.isArray(b.pages) ? b.pages.filter((p) => typeof p === "string") : [], owner: !!b.owner }
}
