// The React Settings (#2101 ST1, ST2a): one search index made from the panes' row
// definitions (Hakim's condition 1), the review id owner only (condition 2),
// and the General pane drawn from its data with every row in search.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { HUB_REACT_PAGES, hubReactPageIds } from "../src/hub/pages"
import { SETTINGS_PAGE, settingsHash } from "../src/hub/settings/address"
import { activeTokens, channelSummary, initials, needsYou, orgNode } from "../src/hub/settings/data"
import ApprovalsPane from "../src/hub/settings/ApprovalsPane"
import GeneralPane from "../src/hub/settings/GeneralPane"
import MenuPane from "../src/hub/settings/MenuPane"
import {
  addAt, barIds, inGroup, inMore, itemMeta, moveItem, newItemId, pageNames, removeItem, renameItem, toggleBar, type MenuItem, type MenuReply,
} from "../src/hub/settings/menu-model"
import InboxPane from "../src/hub/settings/InboxPane"
import JobsPane from "../src/hub/settings/JobsPane"
import { DisclosureContext } from "../src/hub/settings/parts"
import { cronHuman, hookState, hookUrl, inboxBody, inboxChanged, inboxForm, valueLine } from "../src/hub/settings/work-data"
import { SETTINGS_GROUPS, SETTINGS_PANES, paneDef, rowDef } from "../src/hub/settings/panes"
import { buildSettingsIndex, searchSettings } from "../src/hub/settings/search"
import { TooltipProvider } from "../src/hub/ui"
import ActionsPane from "../src/hub/settings/ActionsPane"
import AgentPane from "../src/hub/settings/AgentPane"
import { FilesTab } from "../src/hub/settings/AgentFiles"
import { ChannelsTab, HandoversTab, credentialRefs, integrationBadge } from "../src/hub/settings/AgentLinks"
import {
  type AgentConfig, type AgentState, type CronRow, actionUsers, agentPatch, alsoLines, changedFields, inputsText, modelTier, parseInputs, restartWords, savedValue, showValue,
} from "../src/hub/settings/agent-data"
import { engineName } from "../src/hub/settings/data"

const state = {
  exists: true,
  agents: [
    { id: "dev-session", name: "Dev Session", tier: "claude-code", model: "claude-opus-5-5" },
    { id: "pm-agent", name: "PM", tier: "claude-code", model: "claude-sonnet-5-5" },
    { id: "coder", name: "Coder", tier: "codex-cli", model: "gpt-5.1-codex", access: "public" },
  ],
  wikiCurator: { enabled: true, agent: "" },
  telegram: { enabled: true, accounts: [{}] },
  slack: { enabled: false, botTokenRef: "${SLACK}" },
}
const org = { exists: true, roots: [{ id: "dev-session", title: "Lead developer", reports: [{ id: "pm-agent", title: "Project manager", status: "waiting" }] }], outside: [{ id: "coder", status: "paused" }] }
const live = { nodes: [{ name: "studio", reachable: true, version: "0.288.0", agents: [{ id: "dev-session" }] }, { name: "vps-1", reachable: false, error: "timeout", agents: [{ id: "coder" }] }] }
const tokens = [{ revokedAt: null }, { revokedAt: "2026-11-01" }, { expiresAt: "2000-01-01" }]

function renderGeneral(): string {
  const client = new QueryClient()
  client.setQueryData(["settings", "state"], state)
  client.setQueryData(["settings", "org"], org)
  client.setQueryData(["settings", "live"], live)
  client.setQueryData(["settings", "tokens"], tokens)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, createElement(GeneralPane))),
  )
}

describe("Settings panes: one list, five groups", () => {
  it("every pane sits in a known group, ids are unique, General is built", () => {
    const groups = new Set(SETTINGS_GROUPS.map((g) => g.id))
    expect(SETTINGS_PANES.every((p) => groups.has(p.group))).toBe(true)
    expect(new Set(SETTINGS_PANES.map((p) => p.id)).size).toBe(SETTINGS_PANES.length)
    expect(SETTINGS_PANES.map((p) => p.id)).toEqual([
      "general", "agent", "menu", "inbox", "jobs", "actions", "approvals", "business", "guests", "channels", "whatsapp", "mesh", "machine", "diagnostics",
    ])
    expect(paneDef("general").built).toBe(true)
    expect(paneDef("menu").built).toBe(true)
    expect(SETTINGS_PANES.filter((p) => p.built).every((p) => p.rows.length > 0)).toBe(true)
    expect(paneDef("nope").id).toBe("general")
  })
  it("a row drawn without a definition fails at once", () => {
    expect(() => rowDef("general", "not-a-row")).toThrow(/no row "not-a-row"/)
  })
})

describe("Settings search: made from the row definitions (condition 1)", () => {
  const index = buildSettingsIndex()
  it("holds every row of every pane, and every pane", () => {
    for (const p of SETTINGS_PANES) {
      expect(index.some((e) => e.pane === p.id && e.row === "")).toBe(true)
      for (const r of p.rows) expect(index.some((e) => e.pane === p.id && e.row === r.id)).toBe(true)
    }
  })
  it("every row of every pane is found by its own label (Hakim's review)", () => {
    for (const p of SETTINGS_PANES) {
      for (const r of p.rows) {
        const hits = searchSettings(index, r.label)
        expect(hits.some((h) => h.pane === p.id && h.row === r.id), `${p.id} › ${r.label} is not found by its label`).toBe(true)
      }
    }
  })
  it("every row the General pane draws is in search", () => {
    const html = renderGeneral()
    const drawn = [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])
    expect(drawn.length).toBeGreaterThan(5)
    const inSearch = new Set(index.filter((e) => e.pane === "general").map((e) => e.row))
    for (const id of drawn) expect(inSearch, `row "${id}" is drawn but not in search`).toContain(id)
  })
  it("ranks a label that starts with the words first, and needs every word", () => {
    expect(searchSettings(index, "curator")[0]).toMatchObject({ pane: "general", row: "curator", open: "general-advanced" })
    expect(searchSettings(index, "telegram")[0]).toMatchObject({ row: "channels" })
    expect(searchSettings(index, "jobs")[0]).toMatchObject({ pane: "jobs", row: "" })
    expect(searchSettings(index, "wiki zebra")).toEqual([])
    expect(searchSettings(index, "  ")).toEqual([])
  })
})

describe("Settings page: owner only, on its review id (condition 2)", () => {
  it("is listed owner only, and legacyPages sends it back", () => {
    expect(HUB_REACT_PAGES).toContainEqual({ page: SETTINGS_PAGE, ownerOnly: true })
    expect(hubReactPageIds(true)).toContain(SETTINGS_PAGE)
    expect(hubReactPageIds(false)).not.toContain(SETTINGS_PAGE)
    expect(hubReactPageIds(true, [SETTINGS_PAGE])).not.toContain(SETTINGS_PAGE)
  })
  it("addresses a pane and a row in the old Settings' grammar", () => {
    expect(settingsHash("general", "curator")).toBe("#page=settings-preview&section=general&row=curator")
  })
})

describe("Settings › General", () => {
  it("draws needs-you, agents, machines and the folded Advanced", () => {
    const html = renderGeneral()
    expect(html).toContain("vps-1 does not answer")
    expect(html).toContain("pm-agent waits for your approval")
    expect(html).toContain("3 agents · 1 on")
    expect(html).toContain("Waits for approval")
    expect(html).toContain("claude-opus-5-5")
    expect(html).toContain("1 of 2 on")
    expect(html).toContain("1 active")
    expect(html).toMatch(/data-disclosure="general-advanced" data-state="closed"/)
  })
  it("puts the approval badge under the name below 640 px and beside it above (friction note 1)", () => {
    const html = renderGeneral()
    expect(html).toContain("mt-1 flex sm:hidden")
    expect(html).toContain("hidden sm:flex")
  })
  it("sums what needs you, channels, tokens and initials", () => {
    expect(needsYou(live, state.agents, org).map((f) => f.key)).toEqual(["down-vps-1", "wait-pm-agent"])
    expect(channelSummary(state)).toEqual({ set: ["Telegram", "Slack"], on: ["Telegram"] })
    expect(activeTokens(tokens, Date.parse("2026-11-26"))).toBe(1)
    expect(activeTokens(null)).toBeNull()
    expect(orgNode(org, "pm-agent")?.status).toBe("waiting")
    expect(initials("Dev Session")).toBe("DS")
    expect(initials("coder")).toBe("CO")
  })
})

describe("Settings › General: one relative time format (C17)", () => {
  it("says now, minutes, hours and days", async () => {
    const { relTime } = await import("../src/hub/settings/parts")
    const now = Date.parse("2026-11-26T12:00:00Z")
    expect(relTime(now - 20e3, now)).toBe("now")
    expect(relTime(now - 5 * 60e3, now)).toBe("5m")
    expect(relTime(now - 3 * 3600e3, now)).toBe("3h")
    expect(relTime(now - 2 * 86400e3, now)).toBe("2d")
  })
})

// --- Settings › Menu (#2101 ST5), on the #2149 M1 store ---

const catalog = [
  { label: "", items: [{ key: "wall", label: "Hub", icon: "wall" }, { key: "needs", label: "Waiting on you", icon: "needs" }] },
  { label: "Work", items: [{ key: "projects", label: "Projects", icon: "projects" }, { key: "running", label: "Running now", icon: "live" }, { key: "activity", label: "Activity", icon: "activity" }] },
  { label: "Fleet", items: [{ key: "cost", label: "Cost", icon: "cost" }] },
]
const menuItems: MenuItem[] = [
  { id: "m_aaaaaa1", kind: "page", page: "wall" },
  { id: "m_aaaaaa2", kind: "page", page: "needs", label: "To decide" },
  { id: "m_aaaaaa3", kind: "group", label: "Work" },
  { id: "m_aaaaaa4", kind: "page", page: "projects" },
  { id: "m_aaaaaa5", kind: "view", page: "wall", label: "Client site work", icon: "globe", filter: { project: "site", status: "open" } },
  { id: "pin_aaaaaa6", kind: "link", label: "Grafana", url: "https://grafana.example.com/" },
]
const menuReply: MenuReply = {
  menu: { version: 1, revision: 3, preset: "everything", items: menuItems, bar: ["m_aaaaaa1", "m_aaaaaa2"], lastUsed: {} },
  saved: true, damaged: false, catalog,
  presets: [{ id: "solo", label: "Solo builder" }, { id: "everything", label: "Everything" }, { id: "blank", label: "Blank" }],
  fixedLinks: [], limits: { items: 40, bar: 4, links: 10 },
}

function renderMenu(reply: MenuReply = menuReply): string {
  const client = new QueryClient()
  client.setQueryData(["settings", "menu"], reply)
  client.setQueryData(["settings", "state"], { ...state, hubLayout: { layout: "simple", show: { mobile: false, workflows: true }, overrides: ["workflows"] } })
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, createElement(MenuPane))),
  )
}

describe("Settings › Menu: every row through its def (condition 1)", () => {
  const index = buildSettingsIndex()
  it("draws only rows search has, and the layout switches are rows", () => {
    const html = renderMenu()
    const drawn = [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])
    for (const id of ["reset", "items", "add-item", "bar", "more", "from", "layout", "show-workflows", "reset-layout"]) expect(drawn).toContain(id)
    const inSearch = new Set(index.filter((e) => e.pane === "menu").map((e) => e.row))
    for (const id of drawn) expect(inSearch, `row "${id}" is drawn but not in search`).toContain(id)
    expect(searchSettings(index, "phone bar")[0]).toMatchObject({ pane: "menu", row: "bar" })
    expect(searchSettings(index, "simple full")[0]).toMatchObject({ pane: "menu", row: "layout", open: "menu-advanced" })
  })
  it("draws every row it defines, and search finds each by its label", () => {
    const drawn = new Set([...renderMenu().matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]))
    for (const r of paneDef("menu").rows) {
      expect(drawn, `row "${r.id}" is defined but not drawn`).toContain(r.id)
      expect(searchSettings(index, r.label, 50), `"${r.label}" does not find its row`).toContainEqual(expect.objectContaining({ pane: "menu", row: r.id }))
    }
  })
  it("draws the menu in order, In More, the phone bar and a folded Advanced", () => {
    const html = renderMenu()
    const order = [...html.matchAll(/data-item="mi-([^"]+)"/g)].map((m) => m[1])
    expect(order).toEqual(menuItems.map((i) => i.id))
    expect(html).toContain("Page · was Waiting on you")
    expect(html).toContain("Saved view · Hub · project: site · status: open")
    expect(html).toContain("Link · grafana.example.com")
    expect(html).toContain("2 of 4. More holds everything else.")
    expect(html).toContain("3 pages not in the menu")
    expect(html).toMatch(/data-disclosure="menu-advanced" data-state="closed"/)
  })
  it("ships no suggestion: M1 has lastUsed, but nothing writes it when a page opens", () => {
    expect(renderMenu()).not.toContain("14 days")
  })
  it("puts the phone badge under the name below 640 px; row actions wait for hover (C4)", () => {
    const html = renderMenu()
    expect(html).toContain("mt-1 flex sm:hidden")
    expect(html).toContain("can-hover:group-hover:opacity-100")
    expect(html).toMatch(/aria-label="Move up"/)
  })
  it("says why the menu can't change when the file is damaged", () => {
    const html = renderMenu({ ...menuReply, damaged: true })
    expect(html).toContain("can&#x27;t be read whole")
    expect(html).not.toMatch(/aria-label="Move up"/)
  })
})

describe("Settings › Menu: the steps on the list", () => {
  const names = pageNames(catalog)
  it("moves an item, clamped, and returns the same list when it does not move", () => {
    expect(moveItem(menuItems, "m_aaaaaa4", 0).map((i) => i.id)[0]).toBe("m_aaaaaa4")
    expect(moveItem(menuItems, "m_aaaaaa1", -3)).toBe(menuItems)
    expect(moveItem(menuItems, "m_aaaaaa1", 99).at(-1)!.id).toBe("m_aaaaaa1")
  })
  it("keeps the phone bar to its limit, from the first four while none is saved", () => {
    expect(barIds({ items: menuItems, bar: [] }, 4)).toEqual(["m_aaaaaa1", "m_aaaaaa2", "m_aaaaaa4", "m_aaaaaa5"])
    expect(toggleBar({ items: menuItems, bar: [] }, "m_aaaaaa4", 4)).toEqual(["m_aaaaaa1", "m_aaaaaa2", "m_aaaaaa5"])
    expect(toggleBar({ items: menuItems, bar: ["m_aaaaaa1", "m_aaaaaa2", "m_aaaaaa4", "m_aaaaaa5"] }, "x", 4)).toBeNull()
    expect(removeItem({ items: menuItems, bar: ["m_aaaaaa1"] }, "m_aaaaaa1").bar).toEqual([])
  })
  it("lists In More, groups, names and where a new item goes", () => {
    expect(inMore(menuItems, catalog)).toEqual(["running", "activity", "cost"])
    expect(inGroup(menuItems, 3)).toBe(true)
    expect(inGroup(menuItems, 1)).toBe(false)
    expect(renameItem(menuItems[1], "Waiting on you", names)).toEqual({ id: "m_aaaaaa2", kind: "page", page: "needs" })
    expect(itemMeta(renameItem(menuItems[0], "Home", names), names)).toBe("Page · was Hub")
    expect(addAt(menuItems, { id: "m_bbbbbb1", kind: "page", page: "cost" }).at(-2)!.id).toBe("m_bbbbbb1")
    expect(newItemId("link")).toMatch(/^pin_[a-f0-9]{12}$/)
    expect(newItemId("page")).toMatch(/^m_[a-f0-9]{12}$/)
  })
})

// --- ST2b: Jobs, Approvals and Inbox (#2101) ---

const workState = {
  ...state,
  daemonUrl: "https://hub.example.net:18800/",
  nodeName: "studio",
  crons: [
    { id: "daily-standup", schedule: "0 9 * * 1-5", agent: "pm-agent", prompt: "Post today's plan.", kind: "agent", value: { why: "the team starts aligned", metric: "plan posted by 9:05" }, goal: "Q4 delivery plan",
      changes: [{ at: "2026-11-24T10:12:00Z", field: "schedule", by: "dev-session", old: "0 9 * * *", new: "0 9 * * 1-5", reason: "no plan on weekends" }] },
    { id: "inbox-sweep", schedule: "*/15 * * * *", agent: "cx", prompt: "Answer new client emails.", kind: "agent" },
    { id: "nightly-backup", schedule: "0 2 * * *", agent: "devops-agent", prompt: "agentx backup", kind: "command" },
  ],
  sensors: [{ id: "disk-free", reading: "disk free", every: "5m", targets: ["devops-agent"], last: "41% free", lastAt: Date.parse("2026-11-26T11:00:00Z"), wakes: [] }],
  hostJobs: [],
  webhooks: [
    { id: "main-repo", source: "gitlab", agentId: "dev-session", secretEnv: "GITLAB_WEBHOOK_SECRET", description: "", enabled: true, triggers: { "issues.opened": "triage-issue" }, defaultWorkflow: "dev-intake" },
    { id: "billing", source: "stripe", agentId: "cx", secretEnv: "", description: "", enabled: true, triggers: {}, defaultWorkflow: "" },
  ],
  wikiNotes: { enabled: true, inbox: "dev-session", crons: ["daily-standup"], absorbAgent: "", maxNotesPerRun: 20, maxDeferrals: 3 },
  notifications: {
    longTaskThreshold: 30, destination: { channel: "telegram", chatId: "-1009988776655" },
    on: { taskComplete: true, taskError: true, taskQueued: false },
    local: { banner: true, sound: true, soundName: "Glass", volume: 0.4, icon: "" },
    ntfy: { enabled: false, server: "https://ntfy.sh", topicSet: true, tokenSet: false },
  },
}
const apvSettings = { defaultExpiryDays: 3, maxExpiryDays: 14, laterHours: 4, notifyAgent: true, digest: { enabled: true, time: "09:00" }, desk: { phone: "urgent", computer: "all" } }
const reqSettings = {
  enabled: true, from: ["telegram:100200300"], channels: ["voice", "app"], staleAfterHours: 24, retentionDays: 30, headlines: { enabled: true },
  plans: { enabled: true, stallMinutes: 30, maxNudges: 3, approveKinds: ["message"], disabledAgents: ["cx"], requireForWork: ["code"], requireOverMinutes: 30 },
  checkers: { enabled: ["url", "issue"], checkEveryMinutes: 10 },
}

function renderPane(Pane: () => unknown, open: string[] = []): string {
  const client = new QueryClient()
  client.setQueryData(["settings", "state"], workState)
  client.setQueryData(["settings", "approvals"], apvSettings)
  client.setQueryData(["settings", "requests"], reqSettings)
  client.setQueryData(["settings", "wiki-notes"], { notes: [{ id: "n-7f2c", status: "open", from: "@cx", date: "25 Nov", change: "Support hours moved." }] })
  const disclosure = { isOpen: (id: string) => open.includes(id), setOpen: () => {} }
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null,
      createElement(DisclosureContext.Provider, { value: disclosure }, createElement(Pane as never)))),
  )
}

/** Every pane, every tab: what it draws as data-row is in search. */
const WORK_SHOTS: [string, () => unknown, string[]][] = [
  ["jobs", JobsPane, []], ["jobs", JobsPane, ["jobs-tab-webhooks"]], ["jobs", JobsPane, ["jobs-tab-wiki", "wn-adv"]],
  ["approvals", ApprovalsPane, []], ["inbox", InboxPane, []],
]

describe("Settings › Work panes: every row drawn is in search (condition 1)", () => {
  const index = buildSettingsIndex()
  it.each(WORK_SHOTS)("%s %#", (pane, Pane, open) => {
    expect(paneDef(pane).built).toBe(true)
    const html = renderPane(Pane, open)
    const drawn = [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])
    expect(drawn.length).toBeGreaterThan(1)
    const inSearch = new Set(index.filter((e) => e.pane === pane).map((e) => e.row))
    for (const id of drawn) expect(inSearch, `${pane}: row "${id}" is drawn but not in search`).toContain(id)
  })
  it("finds every Jobs, Approvals and Inbox row by its own label", () => {
    for (const pane of ["jobs", "approvals", "inbox"]) {
      for (const r of paneDef(pane).rows) {
        expect(searchSettings(index, r.label, 100), `${pane}: "${r.label}" not found`).toContainEqual(expect.objectContaining({ pane, row: r.id }))
      }
    }
  })
  it("keeps the Inbox help to one short line (80 characters)", () => {
    const p = paneDef("inbox")
    for (const h of [p.help, ...p.rows.map((r) => r.help ?? "")]) expect(h.length, h).toBeLessThanOrEqual(80)
  })
  it("search opens the tab or the fold a row sits in", () => {
    expect(searchSettings(index, "webhooks")[0]).toMatchObject({ pane: "jobs", row: "webhooks", open: "jobs-tab-webhooks" })
    expect(searchSettings(index, "most notes")[0]).toMatchObject({ pane: "jobs", row: "wn-max", open: "wn-adv" })
    expect(searchSettings(index, "digest")[0]).toMatchObject({ pane: "approvals" })
    expect(searchSettings(index, "ntfy")[0]).toMatchObject({ pane: "inbox" })
  })
})

describe("Settings › Jobs", () => {
  it("draws schedules with their value line, sensors and the row menu", () => {
    const html = renderPane(JobsPane)
    expect(html).toContain("daily-standup")
    expect(html).toContain("Weekdays at 9:00")
    expect(html).toContain("plan posted by 9:05")
    expect(html).toContain("No value line · no goal")
    expect(html).toContain("Change log (1)")
    expect(html).toContain("disk-free")
    expect(html).toContain("More actions for daily-standup")
    // C4: the … shows on hover or focus with a pointer, always on touch.
    expect(html).toContain("can-hover:opacity-0")
  })
  it("draws webhooks with state, address and routing", () => {
    const html = renderPane(JobsPane, ["jobs-tab-webhooks"])
    expect(html).toContain("https://hub.example.net:18800/webhook/dev-session/gitlab")
    expect(html).toContain("Receiving")
    expect(html).toContain("Signing secret missing")
    expect(html).toContain("Routing · 1 trigger · default dev-intake")
    // C4: the badge sits under the name below 640 px.
    expect(html).toContain("mt-1 flex sm:hidden")
  })
  it("draws the wiki notes inbox with Advanced folded open by search", () => {
    const html = renderPane(JobsPane, ["jobs-tab-wiki", "wn-adv"])
    expect(html).toContain("Support hours moved.")
    expect(html).toMatch(/data-disclosure="wn-adv" data-state="open"/)
  })
  it("says a schedule in words and finds what its value line misses", () => {
    expect(cronHuman("*/15 * * * *")).toBe("Every 15 minutes")
    expect(cronHuman("0 2 * * *")).toMatch(/02:00/)
    expect(cronHuman("not a cron")).toBe("")
    expect(valueLine({ id: "x", schedule: "", agent: "a", kind: "command" }).missing).toEqual(["No value line"])
    expect(valueLine({ id: "x", schedule: "", agent: "a", value: { why: "w", metric: "m" } }).missing).toEqual(["No goal"])
    expect(hookUrl("http://h:1/", { agentId: "a b", source: "github" })).toBe("http://h:1/webhook/a%20b/github")
    expect(hookState({ id: "c", source: "custom", agentId: "a", secretEnv: "", description: "", enabled: false, triggers: {}, defaultWorkflow: "" })).toBe("off")
  })
})

describe("Settings › Approvals", () => {
  it("draws the reach, digest, requests and plans, with rare rows folded", () => {
    const html = renderPane(ApprovalsPane)
    expect(html).toMatch(/aria-label="Cards expire after"[^>]*value="3"/)
    expect(html).toContain("telegram:100200300")
    expect(html).toMatch(/data-disclosure="apv-adv" data-state="closed"/)
    expect(html).toMatch(/data-disclosure="lc-adv" data-state="closed"/)
  })
})

describe("Settings › Inbox: a draft with one Save", () => {
  const saved = inboxForm(workState.notifications as never)
  it("reads the saved settings into the form", () => {
    expect(saved).toMatchObject({ channel: "telegram", chat: "-1009988776655", done: true, queued: false, long: "30", soundName: "Glass", ntfy: false })
    const html = renderPane(InboxPane)
    expect(html).toContain("Goes to <span class=\"font-mono\">telegram:-1009988776655</span>")
    expect(html).not.toContain("changes not saved")
  })
  it("sends only what changed on ntfy, and asks for a restart then", () => {
    expect(inboxChanged(saved, { ...saved, queued: true })).toEqual(["queued"])
    const a = inboxBody(saved, { ...saved, queued: true })
    expect(a).toMatchObject({ restart: false, body: { on: { taskQueued: true } } })
    expect("body" in a && "destination" in a.body).toBe(false)
    expect(inboxBody(saved, { ...saved, ntfy: true, topic: "NTFY_TOPIC" })).toMatchObject({ restart: true, body: { ntfy: { enabled: true, topic: "${NTFY_TOPIC}" } } })
    expect(inboxBody(saved, { ...saved, channel: "" , chat: "" })).toMatchObject({ body: { destination: null } })
  })
  it("refuses a secret typed as a variable name, and a half destination", () => {
    expect(inboxBody(saved, { ...saved, topic: "tk_secret-value!" })).toHaveProperty("error")
    expect(inboxBody(saved, { ...saved, chat: "" })).toHaveProperty("error")
    expect(inboxBody(saved, { ...saved, volume: "2" })).toHaveProperty("error")
  })
})

// --- ST2a: Agent and Actions (#2101) ---

const agentState = {
  ...state,
  agents: [
    { ...state.agents[0], mentions: ["@dev", "@dev-session"], systemPrompt: "You are the lead developer.", maxConcurrent: 2, maxExecutionMinutes: 45, permissionMode: "default", wikiAbsorb: true,
      integrations: [{ kind: "gitlab-user", label: "GitLab", credentials: { tokenEnv: "GITLAB_DEV_TOKEN" }, credStatus: { tokenEnv: "set" }, metadata: { host: "gitlab.example.com" } },
        { kind: "sentry", label: "Sentry", credentials: { tokenEnv: "SENTRY_AUTH_TOKEN" }, credStatus: { tokenEnv: "unset" } }] },
    ...state.agents.slice(1),
  ],
  telegram: { enabled: true, accounts: [{ id: "dev", botUsername: "example_dev_bot", agentBinding: "dev-session" }] },
  crons: [{ id: "nightly", agent: "dev-session", model: "" }, { id: "weekly", agent: "dev-session", model: "claude-haiku-5-5" }],
  actions: [
    { id: "deploy-staging", title: "Deploy staging", kind: "shell", command: "make deploy VERSION={{version}}", inputs: [{ name: "version", type: "string", required: true }, { name: "dryRun", type: "boolean" }] },
    { id: "notify-release", title: "Post release to Slack", kind: "http", method: "POST", url: "https://hooks.example.com/$HOOK", inputs: [] },
  ],
} as unknown as AgentState & { agents: AgentConfig[]; crons: CronRow[] }
const workflows = { workflows: [{ id: "release-train", nodes: [{ type: "action.run", config: { actionId: "deploy-staging" } }, { type: "action.run", config: { actionId: "notify-release" } }] }, { id: "ci-watch", nodes: [{ type: "trigger.poll", config: { actionId: "deploy-staging" } }] }] }

function render(el: ReturnType<typeof createElement>, data: [unknown[], unknown][] = []): string {
  const client = new QueryClient()
  client.setQueryData(["settings", "state"], agentState)
  client.setQueryData(["settings", "org"], org)
  client.setQueryData(["settings", "live"], live)
  client.setQueryData(["settings", "tokens"], tokens)
  for (const [k, v] of data) client.setQueryData(k, v)
  ;(globalThis as { location?: unknown }).location ??= { hash: "#page=settings-preview&section=agent&agent=dev-session" }
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, el)))
}
const rowsIn = (html: string) => [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])

describe("Settings › Agent (#2101 ST2a)", () => {
  const agent = agentState.agents[0]
  const tabs = () => [
    render(createElement(AgentPane)),
    render(createElement(FilesTab, { agent, part: "identity" }), [[["settings", "files", "dev-session"], { identity: [{ path: "AGENTS.md", title: "How it works", size: 6300, exists: true }, { path: "MEMORY.md", title: "MEMORY.md", size: 0, exists: false }], skills: [{ slug: "release-notes", title: "Write release notes", size: 900, path: ".claude/skills/release-notes/SKILL.md" }] }]]),
    render(createElement(FilesTab, { agent, part: "skills" }), [[["settings", "files", "dev-session"], { skills: [{ slug: "release-notes", title: "Write release notes", size: 900, path: ".claude/skills/release-notes/SKILL.md" }] }]]),
    render(createElement(ChannelsTab, { agent, state: agentState })),
    render(createElement(HandoversTab, { agent, agents: agentState.agents }), [[["settings", "handovers", "dev-session"], { outgoing: [{ channel: "telegram", chatId: "-100123", toAgent: "pm-agent", expiresAt: "2026-12-01T00:00:00Z", summary: "x", summaryConsumedAt: "y" }], incoming: [] }]]),
  ]
  it("is built, and every row of every tab is drawn and in search (condition 1)", () => {
    expect(paneDef("agent").built).toBe(true)
    const drawn = new Set(tabs().flatMap(rowsIn))
    const index = buildSettingsIndex()
    for (const id of drawn) expect(index.some((e) => e.pane === "agent" && e.row === id), `row "${id}" drawn but not in search`).toBe(true)
    for (const r of paneDef("agent").rows) expect(drawn, `row "${r.id}" in panes.ts but never drawn`).toContain(r.id)
  })
  it("draws the header, the engine with its logo, the model picker and the folded Advanced", () => {
    const html = tabs()[0]
    expect(html).toContain("Dev Session")
    expect(html).toContain("Lead developer")
    expect(html).toContain("runs on <span class=\"font-mono text-xs\">studio</span>")
    expect(html).toContain("claude-opus-5-5")
    expect(html).toMatch(/data-disclosure="agent-advanced" data-state="closed"/)
    expect(html).toContain("27 of 4,000 characters")
  })
  it("search opens the tab a row sits on, and Advanced inside it", () => {
    const index = buildSettingsIndex()
    expect(searchSettings(index, "skills")[0]).toMatchObject({ pane: "agent", row: "skills", open: "agent-tab:skills" })
    expect(searchSettings(index, "longest task")[0]).toMatchObject({ pane: "agent", row: "longest", open: "agent-tab:overview,agent-advanced" })
    expect(searchSettings(index, "sonnet")[0]).toMatchObject({ pane: "agent", row: "model" })
  })
  it("tabs: files, skills with their … menu, integrations, bots, handovers", () => {
    const [, files, skills, channels, handovers] = tabs()
    expect(files).toContain("AGENTS.md")
    expect(files).toContain("not made yet")
    expect(skills).toContain("release-notes")
    expect(skills).toContain("More for release-notes")
    expect(channels).toContain("GITLAB_DEV_TOKEN")
    expect(channels).toContain("Not set")
    expect(channels).toContain("@example_dev_bot")
    expect(handovers).toContain("until 2026-12-01")
    expect(handovers).toContain("No chat is routed to Dev Session.")
  })
  it("a draft: changes, the restart they need, the one PATCH, and what else moves", () => {
    const a = agentState.agents[0]
    const d = { model: "claude-sonnet-5-5", name: "Dev Session " }
    expect(changedFields(a, d)).toEqual(["model"])
    expect(restartWords(["model", "permissionMode"])).toBe("model and tool permissions")
    expect(savedValue(a, "triggerWords")).toBe("@dev, @dev-session")
    expect(agentPatch(a, d)).toMatchObject({ model: "claude-sonnet-5-5", name: "Dev Session", maxConcurrent: 2, access: "private", wikiAbsorb: true })
    expect(alsoLines(a, ["model"], agentState.crons, { spentUsd: 41.2, capUsd: 120 })).toEqual([
      "1 of its recurring jobs follow the agent's model and change too; 1 keep their own.",
      "It has spent $41.20 of its $120 cap this month.",
      "The new model applies after a daemon restart.",
    ])
    expect(showValue("tier", "codex-cli", engineName)).toBe("Codex")
    expect(showValue("model", "", engineName)).toBe("the engine's default")
    expect(modelTier("gpt-5.1-codex")).toBe("codex-cli")
    expect(modelTier("claude-fable-5-2")).toBe("claude-code")
    expect(modelTier("my-own")).toBeUndefined()
  })
  it("an integration's state in one word", () => {
    expect(integrationBadge({ kind: "x", label: "x", credStatus: { t: "set" } }).text).toBe("Set")
    expect(integrationBadge({ kind: "x", label: "x", oauth: { title: "Google", connected: true } }).text).toBe("Connected")
    expect(integrationBadge({ kind: "x", label: "x", enabled: false }).text).toBe("Off")
  })
  it("the pane shows env var names only, even if a daemon sent a literal value", () => {
    const i = { kind: "github-user", label: "GH", credentials: { tokenEnv: "GH_TOKEN", token: "ghp_secret123" }, credStatus: { tokenEnv: "set" as const, token: "literal" as const } }
    expect(credentialRefs(i)).toEqual({ refs: ["GH_TOKEN"], unset: false, literal: ["token"] })
    expect(integrationBadge(i).text).toBe("Secret in file")
    const html = render(createElement(ChannelsTab, { agent: { ...agentState.agents[0], integrations: [i] } as never, state: agentState as never }))
    expect(html).toContain("GH_TOKEN")
    expect(html).not.toContain("ghp_secret123")
  })
})

describe("Settings › Actions (#2101 ST2a)", () => {
  const html = () => render(createElement(ActionsPane), [[["settings", "workflows"], workflows]])
  it("is built, and every row it draws is in search (condition 1)", () => {
    expect(paneDef("actions").built).toBe(true)
    const drawn = new Set(rowsIn(html()))
    for (const r of paneDef("actions").rows) expect(drawn, `row "${r.id}" in panes.ts but never drawn`).toContain(r.id)
    const index = buildSettingsIndex()
    for (const id of drawn) expect(index.some((e) => e.pane === "actions" && e.row === id), `row "${id}" drawn but not in search`).toBe(true)
  })
  it("lists each action with its target, inputs, the workflows that run it, Run and its … menu", () => {
    const out = html()
    expect(out).toContain("2 actions")
    expect(out).toContain("deploy-staging")
    expect(out).toContain("make deploy VERSION={{version}}")
    expect(out).toContain("POST https://hooks.example.com/$HOOK")
    expect(out).toContain("version*: string")
    expect(out).toContain("release-train, ci-watch")
    expect(out).toContain("More for Deploy staging")
    expect(out).toContain(">Run<")
  })
  it("reads which workflows run an action, and the inputs as the old form wrote them", () => {
    expect(actionUsers(workflows.workflows).get("deploy-staging")).toEqual(["release-train", "ci-watch"])
    expect(actionUsers(undefined).size).toBe(0)
    const inputs = parseInputs("version:string!, dryRun:boolean, note")
    expect(inputs).toEqual([
      { name: "version", type: "string", required: true },
      { name: "dryRun", type: "boolean", required: false },
      { name: "note", type: "string", required: false },
    ])
    expect(inputsText(inputs)).toBe("version:string!, dryRun:boolean, note:string")
  })
})

// --- ST3a: Guests, Business, Channels and WhatsApp (#2101) ---

/** Every data-row a pane draws must be one of its row definitions (condition 1). */
function expectDrawnInSearch(pane: string, html: string) {
  const index = buildSettingsIndex()
  const drawn = [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])
  expect(drawn.length).toBeGreaterThan(1)
  const inSearch = new Set(index.filter((e) => e.pane === pane).map((e) => e.row))
  for (const id of drawn) expect(inSearch, `${pane}: row "${id}" is drawn but not in search`).toContain(id)
}

function renderWith(Pane: () => unknown, data: Record<string, unknown>): string {
  const client = new QueryClient()
  for (const [k, v] of Object.entries(data)) client.setQueryData(["settings", k], v)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, createElement(Pane as () => null))),
  )
}

const grants = {
  grants: [
    { id: "g1", name: "Site rebuild", guest: "Example Studio", guestNode: { name: "example-mbp" }, agentId: "coder", level: "propose", state: "active", expiresAt: "2026-12-31T00:00:00Z",
      folders: ["sites/example-web"], skills: ["nextjs"], commands: ["pnpm test"], usage: { turns: 142, tokens: 1_900_000, lastAt: "2026-11-25T14:02:00Z" },
      trail: [{ at: "2026-11-25T14:02:00Z", event: "task", detail: "opened MR !412" }] },
    { id: "g2", name: "Server audit", guest: "Example Logistics", agentId: "dev-session", level: "report", state: "paused", expiresAt: "2026-12-15T00:00:00Z", usage: { turns: 38, tokens: 410_000 } },
    { id: "g3", name: "Support handover", guest: "Sample Guest", agentId: "pm-agent", level: "propose", state: "pending", expiresAt: "2027-01-31T00:00:00Z", usage: { turns: 0, tokens: 0 } },
    { id: "g4", name: "Q3 pricing study", guest: "Atlas Conseil", agentId: "pm-agent", state: "ended", endedAt: "2026-10-02T00:00:00Z" },
  ],
}

describe("Settings › Guests", () => {
  it("is built, and every row it draws is in search", async () => {
    const { default: GuestsPane } = await import("../src/hub/settings/GuestsPane")
    expect(paneDef("guests").built).toBe(true)
    const html = renderWith(GuestsPane, { state, guests: grants })
    expectDrawnInSearch("guests", html)
    expect(html).toContain("3 open")
    expect(html).toContain("Site rebuild")
    expect(html).toContain(">Pause<")
    expect(html).toContain(">Resume<")
    expect(html).toContain("Not joined yet")
    expect(html).toContain("ended 2026-10-02")
    expect(html).toContain("1.9M tokens")
    expect(html).toMatch(/data-disclosure="guests-adv" data-state="closed"/)
    // The badge moves under the name below 640 px (condition 4).
    expect(html).toContain("mt-1 flex sm:hidden")
  })
  it("says each grant's state in words", async () => {
    const { grantState, tokensShort } = await import("../src/hub/settings/GuestsPane")
    expect(grantState({ id: "x", name: "", guest: "", agentId: "", state: "pending", guestNode: { name: "n" } }).word).toBe("Waits for your approval")
    expect(grantState({ id: "x", name: "", guest: "", agentId: "", state: "pending" }).word).toBe("Not joined yet")
    expect(tokensShort(410_000)).toBe("410k")
    expect(tokensShort(1_900_000)).toBe("1.9M")
    expect(tokensShort(12)).toBe("12")
  })
})
