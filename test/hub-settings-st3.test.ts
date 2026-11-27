// Settings › Business, Channels and WhatsApp (#2101 ST3): the pure sums the
// panes draw from, and the panes rendered from stubbed data (invented names).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import BusinessPane from "../src/hub/settings/BusinessPane"
import ChannelsPane from "../src/hub/settings/ChannelsPane"
import WhatsAppPane from "../src/hub/settings/WhatsAppPane"
import { clientRows, columnMap, contactKey, contactMatch, hoursText, orgRows, type OrgSetup } from "../src/hub/settings/business-data"
import { callLength, channelsOn, secretName, sweepLine } from "../src/hub/settings/channels-data"
import { DisclosureContext } from "../src/hub/settings/parts"
import { paneDef } from "../src/hub/settings/panes"
import { buildSettingsIndex, searchSettings } from "../src/hub/settings/search"
import { TooltipProvider } from "../src/hub/ui"

const agents = [{ id: "dev-session", name: "Dev Session" }, { id: "pm-agent", name: "PM" }, { id: "cx", name: "CX" }]
const state = {
  exists: true, agents, daemonUrl: "https://hub.example.net:18800/",
  business: {
    enabled: true,
    projects: [{ id: "example/app", name: "Example app", pm: "pm-agent", lead: "person:sam", client: "example", team: ["agent:dev-session"] }, { id: "sample-co/site" }],
    clients: { example: { name: "Example Co", kind: "own", standing: ["*"] } },
    contactMap: [{ channel: "telegram", chatId: "-1001234567890", client: "demo-studio", displayName: "Demo team" }],
  },
  boards: [{ id: "app", name: "Example board", source: { projects: ["example/app"] }, columns: [{ id: "doing", title: "Doing", kind: "scoped-label", scopedLabel: "Status::Doing" }] }],
  telegram: { enabled: true, accounts: [
    { id: "support", botUsername: "example_support_bot", agentBinding: "cx", botTokenRef: "${TG_SUPPORT_BOT_TOKEN}" },
    { id: "ops", agentBinding: "dev-session", botTokenRef: { literal: true } },
  ] },
  email: { enabled: false, accounts: [] },
  slack: { enabled: false, botTokenRef: null, appTokenRef: null },
  gitlab: { enabled: true, host: "https://gitlab.example.com", tokenRef: "${GITLAB_TOKEN}", routeCount: 2 },
  whatsapp: { enabled: false, sessionDir: "~/.agentx/whatsapp", routeCount: 1 },
  whatsappTriage: { enabled: true, secretEnv: "WACLI_WEBHOOK_SECRET", secretSet: false, rules: [
    { id: "support-line", agent: "cx", chats: ["+1 555 010 2030"], quietHours: { start: "22:00", end: "07:00" } },
    { id: "ops-alerts", agent: "dev-session", enabled: false, chats: ["Ops (group)"], senders: ["+1 555 010 9001"] },
  ] },
  webhooks: [{ id: "repo", source: "github", agentId: "dev-session", enabled: true }],
}
const setup: OrgSetup = {
  members: [
    { ref: "person:sam", kind: "person", id: "sam", name: "Sam Rivera", title: "Founder" },
    { ref: "agent:pm-agent", kind: "agent", id: "pm-agent", name: "PM", title: "Project manager", schedule: { start: "09:00", end: "18:00", days: ["mon", "tue", "wed", "thu", "fri"] } },
    { ref: "agent:cx", kind: "agent", id: "cx", name: "CX" },
  ],
  relations: [
    { from: "agent:pm-agent", to: "person:sam", type: "reports-to" }, { from: "agent:cx", to: "agent:pm-agent", type: "reports-to" },
    { from: "agent:cx", to: "person:sam", type: "acts-for" },
  ],
}

function render(Pane: () => unknown, open: string[] = []): string {
  const client = new QueryClient()
  client.setQueryData(["settings", "state"], state)
  client.setQueryData(["settings", "org"], { exists: true, canEdit: true, setup, choices: { agents: [], people: [], roles: [], types: [] } })
  const disclosure = { isOpen: (id: string) => open.includes(id), setOpen: () => {} }
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null,
    createElement(DisclosureContext.Provider, { value: disclosure }, createElement(Pane as () => null)))))
}

function expectDrawnInSearch(pane: string, html: string) {
  const inSearch = new Set(buildSettingsIndex().filter((e) => e.pane === pane).map((e) => e.row))
  const drawn = [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1])
  expect(drawn.length).toBeGreaterThan(1)
  for (const id of drawn) expect(inSearch, `${pane}: row "${id}" is drawn but not in search`).toContain(id)
}

describe("Settings › Business data", () => {
  it("lays the org chart out under each boss, with the other lines in words", () => {
    const rows = orgRows(setup)
    expect(rows.map((r) => [r.member.id, r.depth])).toEqual([["sam", 0], ["pm-agent", 1], ["cx", 2]])
    expect(rows[2].lines).toEqual(["Acts for Sam Rivera"])
  })
  it("keeps members caught in a boss loop", () => {
    const loop: OrgSetup = { members: setup.members.slice(1), relations: [
      { from: "agent:pm-agent", to: "agent:cx", type: "reports-to" }, { from: "agent:cx", to: "agent:pm-agent", type: "reports-to" },
    ] }
    expect(orgRows(loop).map((r) => r.member.id).sort()).toEqual(["cx", "pm-agent"])
  })
  it("says working hours in short words", () => {
    expect(hoursText(setup.members[1].schedule)).toBe("09:00–18:00 · Mon–Fri")
    expect(hoursText({ start: "08:00", end: "20:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] })).toBe("08:00–20:00 · every day")
    expect(hoursText(undefined)).toBe("")
  })
  it("lists every client that resolves, set up or only named", () => {
    expect(clientRows(state.business).map((c) => [c.id, c.namedBy, !!c.cfg])).toEqual([
      ["demo-studio", "contact", false], ["example", "project", true], ["sample-co", "project", false],
    ])
  })
  it("matches a contact mapping as the old Settings did, and names a column's label", () => {
    const c = { channel: "telegram", chatId: "-100", username: "alex", client: "x" }
    expect(contactKey(c)).toEqual(["chat", "-100"])
    expect(contactMatch(c)).toEqual({ channel: "telegram", chatId: "-100" })
    expect(columnMap({ id: "d", title: "D", kind: "open-backlog" })).toBe("prefix Status")
  })
})

describe("Settings › Channels data", () => {
  it("shows a secret's variable name only, and a literal as Secret in file", () => {
    expect(secretName("${TG_TOKEN}")).toEqual({ name: "TG_TOKEN", set: true, literal: false })
    expect(secretName({ literal: true })).toEqual({ name: "", set: true, literal: true })
    expect(secretName("123:abc")).toEqual({ name: "", set: true, literal: true })
    expect(secretName(null)).toEqual({ name: "", set: false, literal: false })
  })
  it("dots the tabs that are on", () => {
    expect([...channelsOn(state as never)].sort()).toEqual(["github", "gitlab", "telegram"])
  })
  it("says call lengths and sweep results in one line", () => {
    expect(callLength(45)).toBe("45 s")
    expect(callLength(365)).toBe("6 min 05 s")
    expect(sweepLine(true, { scannedContacts: 3, scannedGroups: 1, dryRunEntries: [1, 2], skippedUnchanged: 1 })).toBe("Dry run: 3 contacts and 1 groups read, 2 entries would be written, 1 unchanged.")
  })
})

describe("Settings › Business, Channels, WhatsApp panes", () => {
  it("are built, and every row they draw is in search", () => {
    for (const p of ["business", "channels", "whatsapp"]) expect(paneDef(p).built).toBe(true)
    expectDrawnInSearch("business", render(BusinessPane))
    for (const tab of ["telegram", "email", "slack", "discord", "gitlab", "github", "calls"]) {
      expectDrawnInSearch("channels", render(ChannelsPane, ["ch-tab-" + tab, "sl-adv", "gl-adv"]))
    }
    expectDrawnInSearch("whatsapp", render(WhatsAppPane, ["wa-adv"]))
  })
  it("Business draws the org chart, projects, clients, contacts and boards", () => {
    const html = render(BusinessPane)
    for (const t of ["Sam Rivera", "Reports to no one", "09:00–18:00 · Mon–Fri", "Acts for Sam Rivera", "Example app", "Example Co", "Named by a contact mapping", "Demo team", "Example board", "Status::Doing"]) {
      expect(html).toContain(t)
    }
  })
  it("Channels names the secret's variable, never a value, and links to WhatsApp", () => {
    const html = render(ChannelsPane)
    expect(html).toContain("TG_SUPPORT_BOT_TOKEN")
    expect(html).toContain("Secret in file")
    expect(html).toContain("ops keeps its token in agentx.json")
    expect(html).toContain("section=whatsapp")
  })
  it("WhatsApp says it is off, the secret is not set, and draws the watch rules", () => {
    const html = render(WhatsAppPane)
    expect(html).toContain("WhatsApp is off")
    expect(html).toContain("Not set")
    expect(html).toContain("https://hub.example.net:18800/webhook/wacli")
    expect(html).toContain("support-line")
    expect(html).toContain("quiet 22:00–07:00")
    expect(html).toContain("only from")
  })
  it("search finds a tab's row and opens its tab", () => {
    const index = buildSettingsIndex()
    expect(searchSettings(index, "GitLab host")[0]).toMatchObject({ pane: "channels", row: "gl-host", open: "ch-tab-gitlab,gl-adv" })
    expect(searchSettings(index, "watch rules")[0]).toMatchObject({ pane: "whatsapp" })
  })
})
