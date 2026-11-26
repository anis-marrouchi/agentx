// --- Settings: the panes and their rows (#2101 ST1) ---
//
// The one list of Settings panes, in their side-menu groups, and of the rows
// each pane draws. A pane draws a row only through its definition here
// (SettingsRow takes the def), and search reads the same definitions
// (search.ts), so a row cannot be on screen and missing from search
// (Hakim's condition 1 on #2101, test/hub-settings.test.ts).
//
// Plain data: no React, so the test and search read it without a browser.

import { MENU_ROWS } from "./rows/menu"

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

// Work › Jobs (#2101 ST2b). A tab is opened like a fold: `open` names the
// tab (jobs-tab-*), or the Advanced fold inside the Wiki notes tab.
const JOBS_ROWS = [
  { id: "schedules", label: "Schedules", help: "An agent does something on a timer", words: "cron timer recurring job", open: "jobs-tab-schedules" },
  { id: "add-schedule", label: "Add schedule", help: "A name, an agent, when, and what to do", words: "new cron create", open: "jobs-tab-schedules" },
  { id: "sensors", label: "Sensors", help: "Built-in readers that wake an agent at a level", words: "reading wakes level", open: "jobs-tab-schedules" },
  { id: "host-jobs", label: "Host jobs past their end", help: "Allowed host jobs whose until has passed", words: "allowedHostJobs until expired", open: "jobs-tab-schedules" },
  { id: "webhooks", label: "Webhooks", help: "Addresses other services call when something happens", words: "github gitlab stripe sentry address url", open: "jobs-tab-webhooks" },
  { id: "add-webhook", label: "Add webhook", help: "A source, an agent and a signing secret", words: "new webhook create", open: "jobs-tab-webhooks" },
  { id: "wn-on", label: "Wiki notes on", help: "The schedules and the absorb pass read the notes first", words: "wiki notes inbox", open: "jobs-tab-wiki" },
  { id: "wn-inbox", label: "Inbox agent", help: "Runs the wiki schedule. It may be on another machine.", words: "wiki notes", open: "jobs-tab-wiki" },
  { id: "wn-absorb", label: "Absorb that reads the inbox", help: "The agent whose wiki absorb pass answers the notes", words: "wiki notes", open: "jobs-tab-wiki" },
  { id: "wn-crons", label: "Schedules that read the inbox", help: "Schedules on this machine", words: "wiki notes cron", open: "jobs-tab-wiki" },
  { id: "wn-max", label: "Most notes per run", help: "1 to 100", words: "advanced wiki notes", open: "wn-adv" },
  { id: "wn-defer", label: "Deferrals before a note expires", help: "1 to 20", words: "advanced wiki notes", open: "wn-adv" },
  { id: "wn-recent", label: "Recent notes", help: "Notes on this machine, newest first", words: "wiki notes list", open: "jobs-tab-wiki" },
] as const satisfies readonly SettingsRowDef[]

// Work › Approvals (#2101 ST2b): approval cards, the digest, requests, plans.
const APPROVALS_ROWS = [
  { id: "ap-phone", label: "Send to your phone at once", help: "Nothing: they wait on the Desk and in the digest", words: "approval phone push notify" },
  { id: "ap-computer", label: "Show on this computer at once", help: "A notification on the machine that serves the Hub", words: "approval popup desktop" },
  { id: "ap-expiry", label: "Cards expire after", help: "An agent can ask for longer, up to the limit under Advanced", words: "approval days expiry" },
  { id: "ap-notify", label: "Tell the agent the result", help: "It reads Approved or Declined with your note on its next run", words: "approval agent result" },
  { id: "ap-max", label: "Longest a card may wait", help: "The most an agent may ask for", words: "approval max expiry days", open: "apv-adv" },
  { id: "ap-later", label: "Later hides a card for", help: "How long Later keeps it out of the Desk", words: "approval later snooze hours", open: "apv-adv" },
  { id: "ap-digest", label: "Send one digest a day", help: "One message with everything still waiting", words: "daily digest summary" },
  { id: "ap-time", label: "Digest time", help: "24-hour, on this machine's clock", words: "daily digest hour" },
  { id: "ap-dest", label: "Digest goes to", help: "Empty sends it where notifications go (Inbox)", words: "digest destination telegram chat", open: "dg-adv" },
  { id: "rq-on", label: "Record and follow my requests", help: "What you ask an agent for is followed until it is done", words: "requests loops follow" },
  { id: "rq-stale", label: "Comes back after", help: "A request with no activity this long shows again in Needs you", words: "requests stale hours" },
  { id: "rq-from", label: "Counts as me on shared channels", help: "Who is you in a group chat or on GitHub", words: "requests owner identity", open: "rq-adv" },
  { id: "rq-channels", label: "Channels to record on", help: "None picked records on all of them", words: "requests channels", open: "rq-adv" },
  { id: "rq-keep", label: "Keep closed requests for", help: "Then they are removed", words: "requests retention days", open: "rq-adv" },
  { id: "rq-head", label: "Write a headline when the agent gave none", help: "One small model call per request", words: "requests headline title", open: "rq-adv" },
  { id: "pl-on", label: "Follow requests as plans", help: "A request of two or more steps is followed step by step", words: "plans steps" },
  { id: "pl-stall", label: "Nudge a stalled step after", help: "The step's agent is reminded when it makes no progress", words: "plans stall minutes" },
  { id: "pl-nudges", label: "Nudges before it is blocked", help: "Then you are told the step is blocked", words: "plans nudges", open: "pl-adv" },
  { id: "pl-over", label: "Plan work estimated over", help: "0 never asks for a plan", words: "plans minutes estimate", open: "pl-adv" },
  { id: "pl-approve", label: "Step kinds you approve once", help: "Approved when the plan is made, not at each step", words: "plans approve kinds", open: "pl-adv" },
  { id: "pl-work", label: "Work that must be planned first", help: "Kinds of work an agent plans before it starts", words: "plans require code", open: "pl-adv" },
  { id: "pl-off", label: "Agents that may not open a plan", help: "These agents work without plans", words: "plans disabled agents", open: "pl-adv" },
  { id: "lc-checks", label: "Checks agents may use to close a loop", help: "A page answers, an issue closes, a commit lands", words: "loop checks url issue git reply", open: "lc-adv" },
  { id: "lc-every", label: "Run each check every", help: "How often a loop's check runs", words: "loop checks minutes", open: "lc-adv" },
] as const satisfies readonly SettingsRowDef[]

// Work › Inbox (#2101 ST2b): where a ping goes, when, and agentx notify here.
const INBOX_ROWS = [
  { id: "in-channel", label: "Channel", help: "The chat app that carries the ping", words: "notifications destination telegram whatsapp" },
  { id: "in-chat", label: "Chat id", help: "The chat that gets the ping, such as your own DM with the bot", words: "notifications destination" },
  { id: "in-account", label: "Account", help: "When the channel has several bots. Empty uses the default.", words: "notifications bot", open: "in-adv" },
  { id: "in-done", label: "A task is done", words: "notify ping complete" },
  { id: "in-failed", label: "A task failed", words: "notify ping error" },
  { id: "in-queued", label: "A task is queued", help: "It waits behind another run of the same agent", words: "notify ping queue" },
  { id: "in-long", label: "A task runs longer than", help: "0 turns the long-task ping off", words: "notify long threshold seconds" },
  { id: "in-banner", label: "Show a banner", words: "agentx notify desktop banner" },
  { id: "in-sound", label: "Play a sound", words: "agentx notify sound" },
  { id: "in-sound-name", label: "Sound", help: "A macOS system sound", words: "notify glass ping tink" },
  { id: "in-volume", label: "Volume", help: "From 0 to 1", words: "notify sound volume" },
  { id: "in-icon", label: "Banner icon", help: "A .png, .jpg or .icns path. Empty uses the AgentX logo.", words: "notify icon", open: "inb-adv" },
  { id: "ntfy-on", label: "Phone push", help: "Sends each ping to the ntfy app on your phone too", words: "ntfy notify phone push" },
  { id: "ntfy-topic", label: "Topic", help: "The .env variable that holds the topic", words: "ntfy phone push secret" },
  { id: "ntfy-server", label: "Server", help: "For a self-hosted ntfy", words: "ntfy phone push", open: "ntfy-adv" },
  { id: "ntfy-token", label: "Access token", help: "Optional, for a protected topic. A .env variable name.", words: "ntfy phone push token", open: "ntfy-adv" },
] as const satisfies readonly SettingsRowDef[]

export const SETTINGS_PANES: readonly SettingsPaneDef[] = [
  {
    id: "general", label: "General", icon: "settings-2", group: "general", oldSection: "agents", built: true,
    help: "Your agents and the machines they run on. Only you see Settings; changes save to this machine's agentx.json.",
    rows: GENERAL_ROWS,
  },
  { id: "agent", label: "Agent", icon: "bot", group: "general", oldSection: "agents", help: "One agent's engine, model, files and access.", rows: [] },
  {
    id: "menu", label: "Menu", icon: "panel-left", group: "general", oldSection: "layout", built: true,
    help: "The Hub's side menu and the phone bar. A page you hide stays in More and in ⌘K.",
    rows: MENU_ROWS,
  },
  {
    id: "inbox", label: "Inbox", icon: "inbox", group: "work", oldSection: "inbox", built: true,
    help: "Where task pings go, and what agentx notify does on this machine.",
    rows: INBOX_ROWS,
  },
  {
    id: "jobs", label: "Jobs", icon: "calendar-clock", group: "work", oldSection: "schedules", built: true,
    help: "Work that starts by itself: schedules run an agent on a timer, webhooks run one when another service calls.",
    rows: JOBS_ROWS,
  },
  { id: "actions", label: "Actions", icon: "zap", group: "work", oldSection: "actions", help: "Commands and web calls workflows run.", rows: [] },
  {
    id: "approvals", label: "Approvals", icon: "shield-check", group: "work", oldSection: "inbox", built: true,
    help: "Where approval cards reach you and how long they wait, and how agents follow what you ask them for. Changes save at once.",
    rows: APPROVALS_ROWS,
  },
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
