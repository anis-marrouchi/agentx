// --- The old Settings' addresses, sent to the new Settings (#2101) ---
//
// Anis 2026-11-27: Settings from the side menu and the top bar must open the
// new Settings, with only its own menu. Every pane is built in React now, so
// each old `#page=settings&section=<old>` has a new pane (and a row) to
// open instead. The old Hub script (wall.client.ts) sends the owner there,
// and the daemon's own links are written with newSettingsHref().
//
// Plain data, no imports: the daemon imports this file (as it does
// src/hub/pages.ts), so it must not pull in React or the browser app.

/** The new Settings' page id. On a review id until ST4 renames it to
 *  `settings`; address.ts re-exports it, so this is the one place. */
export const SETTINGS_PAGE = "settings-preview"

/** Old section key (wall-settings.client.ts ST_GROUPS) → new pane and row. */
export const OLD_SETTINGS_SECTIONS: Readonly<Record<string, { section: string; row?: string }>> = {
  agents: { section: "general", row: "agents" },
  channels: { section: "channels" },
  schedules: { section: "jobs" },
  webhooks: { section: "jobs", row: "webhooks" },
  mesh: { section: "mesh" },
  business: { section: "business" },
  boards: { section: "business", row: "boards" },
  actions: { section: "actions" },
  inbox: { section: "inbox" },
  requests: { section: "approvals", row: "rq-on" },
  guests: { section: "guests" },
  tokens: { section: "general", row: "tokens" },
  health: { section: "general", row: "needs-you" },
  diagnostics: { section: "diagnostics" },
  screen: { section: "machine", row: "screen" },
  advanced: { section: "machine", row: "cfg" },
  layout: { section: "menu" },
}

/** The new Settings' hash for an old Settings address: its section (and,
 *  on Agents, the agent) become the new pane, row and agent. No section,
 *  or one the map does not know, opens the new Settings as it opens.
 *  Shipped to the old Hub script by injectFns (wall.client.ts), so it
 *  reads its data from its own properties, not from this module. */
export function newSettingsHref(old?: { section?: string | null; agent?: string | null; under?: string | null }): string {
  const q = new URLSearchParams({ page: newSettingsHref.page })
  const section = (old && old.section) || ""
  if (section === "agents" && old && old.agent) {
    q.set("section", "agent")
    q.set("agent", old.agent)
  } else if (section === "agents" && old && old.under) {
    q.set("section", "general")
    q.set("row", "add-agent")
  } else if (Object.prototype.hasOwnProperty.call(newSettingsHref.map, section)) {
    const to = newSettingsHref.map[section]
    q.set("section", to.section)
    if (to.row) q.set("row", to.row)
  }
  return "#" + q.toString()
}
newSettingsHref.page = SETTINGS_PAGE
newSettingsHref.map = OLD_SETTINGS_SECTIONS
