import { describe, expect, it } from "vitest"
import {
  hubAgentsPopHtml, hubAgo, hubClock, hubEngineChipHtml, hubEnginePopHtml, hubEngineShort, hubEnginesInUse, hubIn,
  hubSpan, hubStatusWord, hubUsageRows, HUB_USAGE_CSS, HUB_USAGE_POP_HTML,
} from "../src/daemon/ui/pages/hub-status-usage"
import { fetchHubUsage, hubUsageFromPlan, resetHubUsageCache } from "../src/daemon/hub-usage-api"
import { activeCliDir } from "../src/agents/cli-accounts"
import { handlePlanUsageApi } from "../src/daemon/plan-usage-api"
import { HUB_STATUS_CSS, HUB_STATUS_HTML } from "../src/daemon/ui/pages/hub-status"
import { renderWallPage } from "../src/daemon/ui/pages/wall"

// #2101 R5, R28: the status bar's plan engines, their limit bars and drop-downs.
const now = Date.UTC(2026, 10, 26, 10)
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
const icon = (k: string) => '<i data-e="' + k + '"></i>'

describe("engines in use (R28a)", () => {
  it("lists only the engines an agent runs on, plan engines first, each agent once, by name", () => {
    const nodes = [
      { name: "Mac", agents: [{ id: "b", name: "Beta", tier: "claude-code" }, { id: "a", name: "Alpha" }, { id: "o", name: "Ops", tier: "orchestrator" }] },
      { name: "box", agents: [{ id: "a", name: "Alpha", tier: "codex-cli" }, { id: "c", name: "Coder", tier: "codex-cli" }] },
    ]
    expect(hubEnginesInUse(nodes)).toEqual([
      { engine: "claude-code", agents: [{ id: "a", name: "Alpha", node: "Mac" }, { id: "b", name: "Beta", node: "Mac" }] },
      { engine: "codex-cli", agents: [{ id: "c", name: "Coder", node: "box" }] },
      // An API engine has an item too, for its spend (R28e).
      { engine: "orchestrator", agents: [{ id: "o", name: "Ops", node: "Mac" }] },
    ])
  })

  it("has no Codex item when no agent uses Codex, and none at all with no agents", () => {
    expect(hubEnginesInUse([{ agents: [{ id: "a", tier: "claude-code" }] }]).map((e) => e.engine)).toEqual(["claude-code"])
    expect(hubEnginesInUse([])).toEqual([])
    expect(hubEnginesInUse([{ name: "x" }, { agents: [{ name: "no id" }] }] as any)).toEqual([])
  })

  it("keeps an item for a plan read on this machine with no agent on it, never for an API engine (R5)", () => {
    const nodes = [{ name: "Mac", agents: [{ id: "a", name: "Alpha", tier: "claude-code" }] }]
    expect(hubEnginesInUse(nodes, ["codex-cli", "sdk"])).toEqual([
      { engine: "claude-code", agents: [{ id: "a", name: "Alpha", node: "Mac" }] },
      { engine: "codex-cli", agents: [] },
    ])
    expect(hubEnginesInUse([], ["claude-code"])).toEqual([{ engine: "claude-code", agents: [] }])
  })

  it("names the engines short", () => {
    expect(hubEngineShort("claude-code")).toBe("Claude")
    expect(hubEngineShort("codex-cli")).toBe("Codex")
    expect(hubEngineShort("other")).toBe("other")
  })
})

describe("usage rows (R28b, R28g)", () => {
  it("orders 5 hours, week, then model weeks; rounds and clamps the percent; tones by use", () => {
    const rows = hubUsageRows([
      { window: "seven_day_opus", utilization: 0.5, at: now },
      { window: "seven_day", utilization: 0.72, resetsAt: now + 3 * 86400_000, at: now },
      { window: "five_hour", utilization: 1.4, resetsAt: now + 3600_000, at: now },
    ], now)
    expect(rows.map((r) => [r.label, r.short, r.pct, r.tone])).toEqual([
      ["5 hours", "5h", 100, "high"], ["Week", "wk", 72, "warn"], ["Week · Opus", "", 50, "ok"],
    ])
  })

  it("drops a window that reset since it was read, and one with neither a number nor a status", () => {
    expect(hubUsageRows([
      { window: "five_hour", utilization: 0.9, resetsAt: now - 1, at: now - 3600_000 },
      { window: "seven_day", at: now },
      { window: "seven_day_sonnet", utilization: NaN, at: now },
    ], now)).toEqual([])
    expect(hubUsageRows(null, now)).toEqual([])
  })

  it("keeps a run's status with no percent, toned by how close it is", () => {
    const rows = hubUsageRows([
      { window: "five_hour", status: "rejected", resetsAt: now + 60_000, at: now },
      { window: "seven_day", status: "allowed_warning", at: now },
    ], now)
    expect(rows.map((r) => [r.key, r.pct, r.status, r.tone])).toEqual([["five_hour", undefined, "rejected", "high"], ["seven_day", undefined, "allowed_warning", "warn"]])
    expect(hubStatusWord("rejected")).toBe("Limit reached")
    expect(hubStatusWord("allowed_warning")).toBe("Near the limit")
    expect(hubStatusWord("allowed")).toBe("Allowed")
  })

  it("labels Codex's unusual windows by their length", () => {
    expect(hubUsageRows([{ window: "window_60m", utilization: 0.1, at: now }, { window: "window_2880m", utilization: 0.1, at: now }], now).map((r) => r.label))
      .toEqual(["2 days", "1 hour"])
    expect([hubSpan(300), hubSpan(10), hubSpan(1440), hubSpan(10080)]).toEqual(["5 hours", "1 hour", "1 day", "7 days"])
  })
})

describe("times", () => {
  it("says how long until a reset and how old a reading is", () => {
    expect(hubIn(30_000)).toBe("in 1m")
    expect(hubIn(12 * 60_000)).toBe("in 12m")
    expect(hubIn(190 * 60_000)).toBe("in 3h 10m")
    expect(hubIn(120 * 60_000)).toBe("in 2h")
    expect(hubIn((2 * 1440 + 4 * 60) * 60_000)).toBe("in 2d 4h")
    expect(hubAgo(10_000)).toBe("just now")
    expect(hubAgo(5 * 60_000)).toBe("5 min ago")
    expect(hubAgo(2 * 3600_000)).toBe("2 h ago")
    expect(hubAgo(3 * 86400_000)).toBe("3 days ago")
  })

  it("puts a reset on the clock, with the day past 24 hours", () => {
    const local = new Date(2026, 10, 26, 9, 5).getTime()
    expect(hubClock(local, local - 3600_000)).toBe("09:05")
    expect(hubClock(local, local - 2 * 86400_000)).toBe("Thu 09:05")
  })
})

describe("status bar items and drop-downs", () => {
  const rows = hubUsageRows([
    { window: "five_hour", utilization: 0.42, resetsAt: now + 90 * 60_000, at: now - 5 * 60_000 },
    { window: "seven_day", utilization: 0.19, resetsAt: now + 3 * 86400_000, at: now - 5 * 60_000 },
  ], now)

  it("the item has the logo, the name and a bar per 5-hour and week window", () => {
    const html = hubEngineChipHtml("claude-code", rows, esc, icon)
    expect(html).toContain('<i data-e="claude-code"></i><span class="hsu__n">Claude</span>')
    expect(html).toContain('<span class="hsu__k">5h</span><span class="hsu__m" role="progressbar" aria-label="5 hours used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="42"><i style="transform:scaleX(0.42)"></i></span><b>42%</b>')
    expect(html).toContain('aria-valuenow="19"')
    expect(html).not.toContain("hsu__flag")
  })

  it("with only a run's status, the item has a dot instead of bars; with nothing, just the name", () => {
    const flagged = hubEngineChipHtml("claude-code", hubUsageRows([{ window: "five_hour", status: "rejected", at: now }], now), esc, icon)
    expect(flagged).toContain('class="hsu__flag" data-tone="high"')
    expect(flagged).not.toContain("progressbar")
    const empty = hubEngineChipHtml("codex-cli", [], esc, icon)
    expect(empty).toBe('<i data-e="codex-cli"></i><span class="hsu__n">Codex</span>')
  })

  it("with the time, each bar says when its window resets (R5)", () => {
    const html = hubEngineChipHtml("claude-code", rows, esc, icon, null, now)
    const at = now + 90 * 60_000
    expect(html).toContain('<b>42%</b><span class="hsu__rs hs__long">resets <time datetime="' + new Date(at).toISOString() + '"')
    expect(html).toContain(">" + hubClock(at, now) + "</time></span>")
    expect(html.match(/hsu__rs/g)).toHaveLength(2)
    expect(hubEngineChipHtml("claude-code", rows, esc, icon)).not.toContain("hsu__rs")
  })

  it("the engine drop-down: bars, reset, when read, its agents, and Add account for the owner (R28b, c, h)", () => {
    const use = { engine: "claude-code", rows: [], readAt: now - 5 * 60_000, source: "plan", plan: "max" }
    const html = hubEnginePopHtml("claude-code", use, rows, [{ id: "a b", name: "Alpha" }], now, esc, icon, true)
    expect(html).toContain("<b>Claude Code</b>")
    expect(html).toContain('<span class="hsu__plan">Max</span>')
    expect(html).toContain('<span class="hsu__l">5 hours</span><span class="hsu__bar" role="progressbar"')
    expect(html).toContain("in 1h 30m")
    expect(html).toContain("Read 5 min ago")
    expect(html).toContain("Used by 1 agent")
    expect(html).toContain('href="#page=chat&amp;agent=a%20b"')
    expect(html).toContain('data-hsu-add="claude"')
    expect(html).not.toContain("not known")
  })

  it("Codex's drop-down says the reading is from its last run, and has no Add account for others", () => {
    const use = { engine: "codex-cli", rows: [], readAt: now - 2 * 3600_000, source: "session" }
    const r = hubUsageRows([{ window: "five_hour", utilization: 0.09, at: now - 2 * 3600_000 }], now)
    const html = hubEnginePopHtml("codex-cli", use, r, [], now, esc, icon, false)
    expect(html).toContain("As of the last Codex run on this machine, 2 h ago")
    expect(html).not.toContain("data-hsu-add")
    expect(html).not.toContain("Used by")
  })

  it("a run-reported status shows its words and no bar; no reading shows no rows and no text (R28g)", () => {
    const r = hubUsageRows([{ window: "five_hour", status: "allowed", resetsAt: now + 60 * 60_000, at: now - 60_000 }], now)
    const html = hubEnginePopHtml("claude-code", { engine: "claude-code", rows: [], readAt: now, source: "runs" }, r, [], now, esc, icon, false)
    expect(html).toContain('<span class="hsu__st">Allowed</span>')
    expect(html).not.toContain("progressbar")
    expect(html).toContain("As the last run reported it, 1 min ago")
    const none = hubEnginePopHtml("claude-code", null, [], [], now, esc, icon, true)
    expect(none).not.toContain("hsu__rows")
    expect(none).not.toContain("hsu__read")
    expect(none).not.toContain("not known")
    expect(none).toContain("Add account")
    const login = hubEnginePopHtml("claude-code", { engine: "claude-code", rows: [], readAt: now, source: "runs", unread: "login" }, r, [], now, esc, icon, false)
    expect(login).toContain("Plan usage not read: the Claude login on this machine has run out. Sign in again with <code>claude /login</code>.")
    expect(login).toContain('<span class="hsu__st">Allowed</span>')
    const wait = hubEnginePopHtml("claude-code", { engine: "claude-code", rows: [], readAt: null, source: "plan", unread: "rate-limited" }, [], [], now, esc, icon, false)
    expect(wait).toContain("Plan usage not read yet: Claude's usage service asked to wait.")
  })

  it("the agents drop-down: state, engine, and Chat / Open run / Pause / Stop run (R28f)", () => {
    const list = [
      { id: "cx", name: "CX", face: "C", color: "#123", state: "working", paused: false, tier: "codex-cli", line: "Fixing <b>", runHref: "#page=task&id=1", stopHtml: '<button data-lv="pause">Stop run</button>' },
      { id: "pm", name: "PM", face: "P", color: null, state: "idle", paused: true, tier: "claude-code", line: "", runHref: "", stopHtml: "" },
    ]
    const html = hubAgentsPopHtml(list, true, "Paused.", esc, icon)
    expect(html).toContain("1 working · 2 in all")
    expect(html).toContain('class="hsg__r is-working"')
    expect(html).toContain('class="hsg__r is-paused"')
    expect(html).toContain('<span class="hsg__st">Working</span>')
    expect(html).toContain('<span class="hsg__st">Paused</span>')
    expect(html).toContain('<i data-e="codex-cli"></i>')
    expect(html).toContain("Fixing &lt;b>")
    expect(html).toContain('href="#page=chat&amp;agent=cx">Chat</a>')
    expect(html).toContain('href="#page=task&amp;id=1">Open run</a>')
    expect(html).toContain('data-hsu-hold="pause" data-id="cx"')
    expect(html).toContain('data-hsu-hold="resume" data-id="pm"')
    expect(html).toContain('data-lv="pause">Stop run')
    expect(html).toContain('role="status">Paused.')
    // Only the owner can hold an agent.
    expect(hubAgentsPopHtml(list, false, "", esc, icon)).not.toContain("data-hsu-hold")
    expect(hubAgentsPopHtml([], false, "", esc, icon)).toContain("No agents yet.")
  })

  it("the bar holds the engines box, the agents trigger and the one shared drop-down, never \"not known\"", () => {
    expect(HUB_STATUS_HTML).toContain('<span class="hsu" id="hs-engines"></span>')
    expect(HUB_STATUS_HTML).toContain('data-hsu-pop="agents"')
    expect(HUB_STATUS_HTML).toContain(HUB_USAGE_POP_HTML)
    expect(HUB_STATUS_HTML).not.toContain("hs-claude")
    expect(HUB_STATUS_HTML).not.toContain("not known")
    const page = renderWallPage({ owner: true })
    expect(page).toContain('id="hsu-pop"')
    expect(page).toContain(".hsu-pop {")
    expect(page).toContain("function hubEnginesInUse")
    expect(page).toContain("/api/admin/hub/usage")
  })

  it("fits 900 px: names go, logos and bars stay; motion respects reduced motion", () => {
    const narrow = HUB_USAGE_CSS.slice(HUB_USAGE_CSS.indexOf("@media (max-width: 1180px)"))
    expect(narrow).toContain(".hsu__n, .hs__long { display: none; }")
    // One popover recipe for the bar (hub-status.ts): scale(.98) over 150ms, none under reduced motion.
    expect(HUB_STATUS_CSS).toContain(".hsa:not([hidden]), .hsu-pop:not([hidden]) { animation: hs-pop 150ms")
    expect(HUB_STATUS_CSS).toContain("@media (prefers-reduced-motion: reduce) { .hsa:not([hidden]), .hsu-pop:not([hidden]) { animation: none; } }")
    // C12: row actions hide at rest with a mouse, show on hover or focus, and stay on touch.
    expect(HUB_USAGE_CSS).toContain("@media (hover: hover) { .hsg__acts { opacity: 0; transition: opacity 150ms; }")
    expect(HUB_USAGE_CSS).not.toContain("opacity: .55")
    // C10: the state colours are tokens (the avatar's #fff waits for the shared avatar, S3).
    for (const hex of ["#f59e0b", "#e40014", "#f5a524", "#2fbf71"]) expect(HUB_USAGE_CSS).not.toContain(hex)
    // The bars grow with transform, not width, in 200ms (C18).
    expect(HUB_USAGE_CSS).toContain("transition: transform 200ms")
    expect(HUB_USAGE_CSS).toContain("@media (prefers-reduced-motion: reduce) { .hsu__m i, .hsu__bar i { transition: none; } }")
  })
})

describe("the daemon's readings, shaped for the bar (R28g causes 1 and 3)", () => {
  const plan = (o: Record<string, unknown> = {}) => ({
    reader: { reading: { readAt: now - 60_000, windows: [{ window: "five_hour", utilization: 0.4, resetsAt: now + 3600_000 }, { window: "seven_day", utilization: 0.2 }] } },
    provider: [],
    ...o,
  })

  it("uses the Claude reader's fresh reading", () => {
    const u = hubUsageFromPlan(plan(), now)
    expect(u.engines).toEqual([{
      engine: "claude-code", source: "plan", readAt: now - 60_000,
      rows: [{ window: "five_hour", utilization: 0.4, resetsAt: now + 3600_000, at: now - 60_000 }, { window: "seven_day", utilization: 0.2, at: now - 60_000 }],
    }])
    expect(u.windows).toEqual([{ window: "five_hour", utilization: 0.4, resetsAt: now + 3600_000 }, { window: "seven_day", utilization: 0.2 }])
    expect(u.readAt).toBe(now - 60_000)
  })

  it("ignores a reading older than 30 minutes and falls back to what runs reported, status and all", () => {
    const u = hubUsageFromPlan(plan({
      reader: { reading: { readAt: now - 31 * 60_000, windows: [{ window: "five_hour", utilization: 0.9 }] } },
      provider: [{ window: "five_hour", status: "allowed", resetsAt: now + 3600_000, seenAt: now - 120_000 }],
    }), now)
    expect(u.engines).toEqual([{ engine: "claude-code", source: "runs", readAt: now - 120_000, rows: [{ window: "five_hour", status: "allowed", resetsAt: now + 3600_000, at: now - 120_000 }] }])
    expect(u.windows).toEqual([])
  })

  it("a newer run percentage wins over the reading; a status alone never replaces a percentage", () => {
    const u = hubUsageFromPlan(plan({
      provider: [
        { window: "five_hour", utilization: 0.55, seenAt: now - 10_000 },
        { window: "seven_day", status: "allowed_warning", seenAt: now - 10_000 },
        { window: "seven_day_opus", status: "allowed", seenAt: now - 10_000 },
        { window: "bad" },
      ],
    }), now)
    const rows = u.engines[0].rows
    expect(rows.find((r) => r.window === "five_hour")).toEqual({ window: "five_hour", utilization: 0.55, at: now - 10_000 })
    expect(rows.find((r) => r.window === "seven_day")?.utilization).toBe(0.2)
    expect(rows.find((r) => r.window === "seven_day_opus")?.status).toBe("allowed")
    expect(rows.some((r) => r.window === "bad")).toBe(false)
  })

  it("adds Codex from its session reading, with its plan", () => {
    const u = hubUsageFromPlan(plan({ codex: { readAt: now - 3600_000, plan: "plus", windows: [{ window: "five_hour", utilization: 0.09, resetsAt: now + 60_000 }, { window: "x" }] } }), now)
    expect(u.engines[1]).toEqual({ engine: "codex-cli", source: "session", plan: "plus", readAt: now - 3600_000, rows: [{ window: "five_hour", utilization: 0.09, resetsAt: now + 60_000, at: now - 3600_000 }] })
  })

  // #2101 R5: on the Mac the reader never read a % (its login had run out),
  // so the item said only "Claude". The drop-down now says why.
  it("says why the plan % is not read: a lapsed login or a wait asked by the usage service", () => {
    const lapsed = hubUsageFromPlan(plan({
      reader: { reading: null, lastError: { kind: "stale-login", message: "x", at: now } },
      provider: [{ window: "seven_day", status: "allowed", resetsAt: now + 3600_000, seenAt: now - 10_000 }],
    }), now)
    expect(lapsed.engines[0]).toMatchObject({ engine: "claude-code", source: "runs", unread: "login" })
    const waiting = hubUsageFromPlan(plan({ reader: { reading: null, lastError: { kind: "rate-limited", message: "x", at: now } } }), now)
    expect(waiting.engines).toEqual([{ engine: "claude-code", rows: [], readAt: null, source: "plan", unread: "rate-limited" }])
    // A fresh reading says nothing more; an error the owner cannot act on says nothing.
    expect(hubUsageFromPlan(plan({ reader: { ...plan().reader, lastError: { kind: "stale-login" } } }), now).engines[0].unread).toBeUndefined()
    expect(hubUsageFromPlan(plan({ reader: { reading: null, lastError: { kind: "failed" } } }), now).engines).toEqual([])
  })

  it("has no engines with no readings at all", () => {
    expect(hubUsageFromPlan({}, now)).toEqual({ engines: [], windows: [], readAt: null })
    expect(hubUsageFromPlan(null, now)).toEqual({ engines: [], windows: [], readAt: null })
    expect(hubUsageFromPlan(plan({ codex: null, reader: {} }), now).engines).toEqual([])
  })

  it("the dashboard asks the daemon's /usage/plan with the mesh token, and fails loudly on an error", async () => {
    resetHubUsageCache()
    const calls: Array<{ url: string; auth?: string }> = []
    const ok = (async (url: string, init: any) => { calls.push({ url, auth: init.headers.Authorization }); return new Response(JSON.stringify(plan()), { status: 200 }) }) as any
    const config = { dashboard: { daemonUrl: "http://127.0.0.1:4000/", token: "dash", daemons: [] } } as any
    const u = await fetchHubUsage(config, ok, { MESH_TOKEN: "mesh" }, now)
    expect(calls).toEqual([{ url: "http://127.0.0.1:4000/usage/plan", auth: "Bearer mesh" }])
    expect(u.engines[0].engine).toBe("claude-code")
    await fetchHubUsage(config, ok, {}, now)
    expect(calls[1].auth).toBe("Bearer dash")
    const bad = (async () => new Response("no", { status: 401 })) as any
    resetHubUsageCache()
    await expect(fetchHubUsage(config, bad, {}, now, () => {})).rejects.toThrow("daemon usage read answered 401")
  })

  it("a daemon that does not answer in time leaves its last answer standing for 15 minutes, aged by today's clock (R5)", async () => {
    resetHubUsageCache()
    const config = { dashboard: { daemonUrl: "http://127.0.0.1:4000", token: "dash", daemons: [] } } as any
    const ok = (async () => new Response(JSON.stringify(plan()), { status: 200 })) as any
    const slow = (async () => { throw new Error("The operation was aborted due to timeout") }) as any
    const logs: string[] = []
    const first = await fetchHubUsage(config, ok, {}, now)
    const again = await fetchHubUsage(config, slow, {}, now + 60_000, (m) => logs.push(m))
    expect(again).toEqual(hubUsageFromPlan(plan(), now + 60_000))
    expect(again.engines.map((e) => e.engine)).toEqual(first.engines.map((e) => e.engine))
    expect(logs).toEqual(["[hub] daemon usage not read, last answer used: The operation was aborted due to timeout"])
    await expect(fetchHubUsage(config, slow, {}, now + 16 * 60_000, (m) => logs.push(m))).rejects.toThrow("timeout")
    expect(logs[1]).toBe("[hub] daemon usage not read: The operation was aborted due to timeout")
  })

  it("the daemon's /usage/plan carries Codex only when it was read", () => {
    const withCodex = handlePlanUsageApi("GET", "/usage/plan", now, { codex: { windows: [], readAt: now } })
    expect((withCodex.body as any).codex).toEqual({ windows: [], readAt: now })
    expect((handlePlanUsageApi("GET", "/usage/plan", now, { codex: null }).body as any).codex).toBeNull()
    expect("codex" in (handlePlanUsageApi("GET", "/usage/plan", now).body as any)).toBe(false)
  })
})

describe("activeCliDir (R28g cause 2: read the account runs use)", () => {
  it("is the active profile's folder, else the env variable, else the CLI default", () => {
    const state = { codex: { profiles: [{ name: "work", dir: "/w/codex" }], active: "work" }, claude: { profiles: [{ name: "x", dir: "/x" }], active: "default" } }
    expect(activeCliDir("codex", state, {}, "/home/you")).toBe("/w/codex")
    expect(activeCliDir("claude", state, { CLAUDE_CONFIG_DIR: " /env/claude " }, "/home/you")).toBe("/env/claude")
    expect(activeCliDir("claude", {}, {}, "/home/you")).toBe("/home/you/.claude")
    expect(activeCliDir("codex", {}, {}, "/home/you")).toBe("/home/you/.codex")
  })
})
