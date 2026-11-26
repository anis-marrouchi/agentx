// The React Settings (#2101 ST1): one search index made from the panes' row
// definitions (Hakim's condition 1), the review id owner only (condition 2),
// and the General pane drawn from its data with every row in search.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { HUB_REACT_PAGES, hubReactPageIds } from "../src/hub/pages"
import { SETTINGS_PAGE, settingsHash } from "../src/hub/settings/address"
import { activeTokens, channelSummary, initials, needsYou, orgNode } from "../src/hub/settings/data"
import GeneralPane from "../src/hub/settings/GeneralPane"
import { SETTINGS_GROUPS, SETTINGS_PANES, paneDef, rowDef } from "../src/hub/settings/panes"
import { buildSettingsIndex, searchSettings } from "../src/hub/settings/search"
import { TooltipProvider } from "../src/hub/ui"

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
    const { relTime } = await import("../src/hub/settings/GeneralPane")
    const now = Date.parse("2026-11-26T12:00:00Z")
    expect(relTime(now - 20e3, now)).toBe("now")
    expect(relTime(now - 5 * 60e3, now)).toBe("5m")
    expect(relTime(now - 3 * 3600e3, now)).toBe("3h")
    expect(relTime(now - 2 * 86400e3, now)).toBe("2d")
  })
})
