// --- The Hub pages React draws (#2218) ---
//
// The one list the daemon and the React app share. The daemon reads it to
// tell the old Hub script which `#page=` ids belong to React (so it hides its
// own sections for them); the registry (registry.ts) checks that every route
// an extension adds is listed here (test/hub-registry.test.ts).
//
// Plain data only: the daemon imports this file, so it must not import React
// or anything from the browser app.

export interface HubReactPage {
  /** The `#page=` id, the same grammar as the old Hub (`#page=jobledger`). */
  page: string
  /** Only the owner sees it; anyone else stays on the old Hub. */
  ownerOnly?: boolean
}

export const HUB_REACT_PAGES: readonly HubReactPage[] = [
  // The component catalog (#2218 part 4): every part of src/hub/ui in light
  // and dark, plus the live stream's state. Owner only.
  { page: "catalog", ownerOnly: true },
  // The simple shell (#2226 S3): side menu, chat, right tabs. Owner only,
  // as the chat is; /hub opens on it in the simple layout (shell.ts).
  { page: "home", ownerOnly: true },
]

/** The React page ids this viewer gets, minus the ones sent back to the old
 *  code (`dashboard.hub.legacyPages`). */
export function hubReactPageIds(owner: boolean, legacyPages: readonly string[] = []): string[] {
  return HUB_REACT_PAGES
    .filter((p) => (owner || !p.ownerOnly) && !legacyPages.includes(p.page))
    .map((p) => p.page)
}
