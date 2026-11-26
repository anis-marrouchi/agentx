// --- Settings: the panes and their rows (#2101 ST1) ---
//
// The one list of Settings panes, in their side-menu groups, and of the rows
// each pane draws. A pane draws a row only through its definition here
// (SettingsRow takes the def), and search reads the same definitions
// (search.ts), so a row cannot be on screen and missing from search
// (Hakim's condition 1 on #2101, test/hub-settings.test.ts).
//
// Plain data: no React, so the test and search read it without a browser.

export type SettingsGroupId = "general" | "work" | "people" | "connections" | "system"

export interface SettingsRowDef {
  /** The row's id: `data-row` on screen, `#row=` in the address. */
  id: string
  label: string
  /** The one line of help under the label. Also searched. */
  help?: string
  /** More words search should find it by. */
  words?: string
  /** The disclosure (Advanced) the row sits in; search opens it. */
  open?: string
}

export interface SettingsPaneDef {
  id: string
  label: string
  /** An icon name from src/hub/ui/icons. */
  icon: string
  group: SettingsGroupId
  /** The line under the pane's title. */
  help: string
  /** Where the old Settings shows it (`#page=settings&section=`), for panes
   *  not built in React yet. */
  oldSection: string
  /** Built in React. The rest open on a line that links to the old page. */
  built?: boolean
  rows: readonly SettingsRowDef[]
}

export const SETTINGS_GROUPS: readonly { id: SettingsGroupId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "work", label: "Work" },
  { id: "people", label: "People" },
  { id: "connections", label: "Connections" },
  { id: "system", label: "System" },
]

const GENERAL_ROWS = [
  { id: "needs-you", label: "Needs you", help: "Machines that do not answer and restarts that wait", words: "fix problem down restart" },
  { id: "agents", label: "Agents", help: "Turn an agent on or off; off starts no new run", words: "agent on off pause resume hold" },
  { id: "add-agent", label: "Add agent", help: "A new role with its own wake words and workspace", words: "new create agent" },
  { id: "machines", label: "Machines", help: "What this hub can reach right now", words: "health node answering version restart mesh" },
  { id: "channels", label: "Channels", help: "Chat apps and developer tools that are on", words: "telegram whatsapp slack discord email gitlab" },
  { id: "tokens", label: "Tokens", help: "Keys for apps, scripts and other machines", words: "token key api access" },
  { id: "curator", label: "Wiki page curator", help: "A chat bubble on every wiki page; an agent edits the open page", words: "wiki bubble edit", open: "general-advanced" },
  { id: "curator-agent", label: "Agent that answers", help: "Who edits the page when you type in the bubble", words: "wiki curator agent owner", open: "general-advanced" },
] as const satisfies readonly SettingsRowDef[]

export const SETTINGS_PANES: readonly SettingsPaneDef[] = [
  {
    id: "general", label: "General", icon: "settings-2", group: "general", oldSection: "agents", built: true,
    help: "Your agents and the machines they run on. Only you see Settings; changes save to this machine's agentx.json.",
    rows: GENERAL_ROWS,
  },
  { id: "agent", label: "Agent", icon: "bot", group: "general", oldSection: "agents", help: "One agent's engine, model, files and access.", rows: [] },
  { id: "menu", label: "Menu", icon: "panel-left", group: "general", oldSection: "layout", help: "What the side menu shows, and in which order.", rows: [] },
  { id: "inbox", label: "Inbox", icon: "inbox", group: "work", oldSection: "inbox", help: "How the inbox reaches you.", rows: [] },
  { id: "jobs", label: "Jobs", icon: "calendar-clock", group: "work", oldSection: "schedules", help: "Recurring jobs and calls from other services.", rows: [] },
  { id: "actions", label: "Actions", icon: "zap", group: "work", oldSection: "actions", help: "Commands and web calls workflows run.", rows: [] },
  { id: "approvals", label: "Approvals", icon: "shield-check", group: "work", oldSection: "inbox", help: "What waits for your yes, and requests.", rows: [] },
  { id: "business", label: "Business", icon: "building-2", group: "people", oldSection: "business", help: "Org chart and business settings.", rows: [] },
  { id: "guests", label: "Guests", icon: "user-round-plus", group: "people", oldSection: "guests", help: "Who else may use your agents.", rows: [] },
  { id: "channels", label: "Channels", icon: "message-square", group: "connections", oldSection: "channels", help: "Chat apps and developer tools.", rows: [] },
  { id: "whatsapp", label: "WhatsApp", icon: "message-circle", group: "connections", oldSection: "channels", help: "WhatsApp numbers and who they answer.", rows: [] },
  { id: "mesh", label: "Mesh", icon: "network", group: "connections", oldSection: "mesh", help: "Your other machines and tokens.", rows: [] },
  { id: "machine", label: "Machine", icon: "monitor", group: "system", oldSection: "advanced", help: "This machine, screen capture and agentx.json.", rows: [] },
  { id: "diagnostics", label: "Diagnostics", icon: "activity", group: "system", oldSection: "diagnostics", help: "Errors, routing, rotations and checks.", rows: [] },
]

export type GeneralRowId = (typeof GENERAL_ROWS)[number]["id"]

export const DEFAULT_PANE = "general"

export function paneDef(id: string | null | undefined): SettingsPaneDef {
  return SETTINGS_PANES.find((p) => p.id === id) ?? SETTINGS_PANES[0]
}

/** A pane's row by id; throws so a row drawn without a definition fails at
 *  once in dev and in the test, not silently out of search. */
export function rowDef(pane: string, id: string): SettingsRowDef {
  const row = paneDef(pane).rows.find((r) => r.id === id)
  if (!row) throw new Error(`settings: pane "${pane}" has no row "${id}" in src/hub/settings/panes.ts`)
  return row
}
