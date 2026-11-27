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
  // The new Settings (#2101 ST1-ST3), on a review id until all its panes
  // are built; ST4 moves it to `settings`. Owner only, and like every page
  // here `dashboard.hub.legacyPages` sends it back to the old code.
  { page: "settings-preview", ownerOnly: true },
  // The one Task page per request (#2101 T1), on a review id while the old
  // post page (`#post=`) and run page (`#page=task`) keep their addresses;
  // T3 sends them here. Owner only, like the old post page's actions.
  { page: "task-preview", ownerOnly: true },
  // The feed (#2101), drawn to the approved orca mock of #2387, on a review
  // id until Anis accepts it; the old feed stays on `#status=open`. Owner
  // only, and `dashboard.hub.legacyPages` sends it back like the rest.
  { page: "feed-preview", ownerOnly: true },
]

/** The React page ids this viewer gets, minus the ones sent back to the old
 *  code (`dashboard.hub.legacyPages`). */
export function hubReactPageIds(owner: boolean, legacyPages: readonly string[] = []): string[] {
  return HUB_REACT_PAGES
    .filter((p) => (owner || !p.ownerOnly) && !legacyPages.includes(p.page))
    .map((p) => p.page)
}
