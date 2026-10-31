import { describe, expect, it } from "vitest"
import { openWall, settingsHtml, type Route } from "./wall-settings-harness"

// #1449: Settings › Diagnostics has the seven tabs of classic /admin/health,
// read-only, from the endpoints that page reads.

const OVERVIEW = {
  kpis: { tasksToday: 12, tasksDelta: 3, errorsToday: 2, errorRate: 0.1667, avgDurationMs: 4200, p50DurationMs: 3000, p95DurationMs: 9000, spendToday: 1.25, spendDelta: -0.5 },
  perAgent: [{ agent_id: "cx", tasks: 10, errors: 2, avg_duration_ms: 4000, last_active: "2026-10-31T10:00:00Z" }],
  perChannel: [{ channel: "telegram", tasks: 12, errors: 2 }],
  idleAgents: ["ops"],
  recentErrors: [{ started_at: "2026-10-31T10:00:00Z", agent_id: "cx", channel: "telegram", plain: "The agent took too long", message_preview: "<i>slow</i>" }],
}
const ACTIVITY = {
  hourly: [{ hour: "09:00", tasks: 4, errors: 1 }, { hour: "10:00", tasks: 8, errors: 0 }],
  daily: [{ day: "2026-10-31", tasks: 12, errors: 1 }],
  perAgent: [{ agent_id: "cx", tasks_24h: 12, tasks_7d: 70, errors_7d: 3, avg_duration_ms: 4000, last_active: "2026-10-31T10:00:00Z" }],
}
const ERRORS = { rows: [{ started_at: "2026-10-31T10:00:00Z", agent_id: "cx", channel: "telegram", message_preview: "hi <b>" + "x".repeat(80), error: "ETIMEDOUT", plain: "The agent took too long" }] }
const ROUTING = { rows: [{ at: "2026-10-31T10:01:00Z", channel: "telegram", chat_id: "42", kind: "dm", deciding_stage: "mention", agent_id: "cx", reason: "@cx" }] }
const ROTATIONS = { rows: [{ rotated_at: "2026-10-31T10:02:00Z", agent_id: "ops", channel: "slack", reason: "tier-2", last_turn_input_tokens: 210000 }] }
const DOCTOR = { summary: { ok: 1, warnings: 1, errors: 0 }, checks: [
  { group: "Runtime", severity: "ok", title: "Node 22", detail: "" },
  { group: "Runtime", severity: "warn", title: "Disk almost full", detail: "97% used", fix: "Free some space" },
] }

const base: Route = (u) => u.startsWith("/api/admin/observability/overview") ? { status: 200, body: OVERVIEW }
  : u.startsWith("/api/admin/observability/activity") ? { status: 200, body: ACTIVITY }
  : u.startsWith("/api/admin/observability/errors") ? { status: 200, body: ERRORS }
  : u.startsWith("/api/admin/observability/routing") ? { status: 200, body: ROUTING }
  : u.startsWith("/api/admin/observability/rotations") ? { status: 200, body: ROTATIONS }
  : u.startsWith("/api/admin/doctor") ? { status: 200, body: DOCTOR } : undefined
const open = (route?: Route) => openWall({ hash: "#page=settings&section=diagnostics", route: (u, i) => route?.(u, i) ?? base(u, i) })

describe("Hub Settings: Diagnostics (#1449)", () => {
  it("is listed under Machines and opens on Overview, escaped, with the classic call", async () => {
    const w = open()
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("Errors, routing, rotations and checks")
    expect(html).toContain("Tasks today")
    expect(html).toContain("▲ 3 vs yesterday")
    expect(html).toContain("16.7% of tasks")
    expect(html).toContain("▼ $0.50 vs yesterday")
    expect(html).toContain("No task in the last 24 hours: ops.")
    expect(html).toContain("The agent took too long")
    expect(html).toContain("&lt;i&gt;slow&lt;/i&gt;")
    expect(w.calls.some((c) => c.url === "/api/admin/observability/overview")).toBe(true)
    expect(w.writes()).toEqual([])
  })

  it("draws Activity as bars with the errors' share, and Errors cuts the message at 60 characters", async () => {
    const w = open()
    await w.settle()
    await w.click({ "data-st-act": "dg-tab", "data-id": "activity" })
    let html = settingsHtml(w)
    expect(html).toContain('style="height:50%;--err:25%"')
    expect(html).toContain("09:00: 4 tasks, 1 errors")
    expect(html).toContain("<td>70</td>")
    await w.click({ "data-st-act": "dg-tab", "data-id": "errors" })
    html = settingsHtml(w)
    expect(html).toContain("hi &lt;b&gt;" + "x".repeat(54) + "</td>")
    expect(html).not.toContain("x".repeat(55))
  })

  it("tails the daemon's output in place, filters it, and stops when the section closes", async () => {
    const w = open()
    await w.settle()
    await w.click({ "data-st-act": "dg-tab", "data-id": "logs" })
    expect(w.sources).toHaveLength(1)
    const es = w.sources[0]
    expect(es.url).toBe("/api/admin/logs/stream")
    const paints = w.paints()
    es.on.open({})
    es.on.line({ data: "[cx] ERROR boom <x>" })
    es.on.line({ data: "[ops] all good" })
    expect(w.paints()).toBe(paints)
    expect(w.el("st-dg-status").textContent).toBe("live")
    expect(w.el("st-dg-logs").innerHTML).toContain('<span class="is-err">[cx] ERROR boom &lt;x&gt;')
    await w.type("st-dg-filter", "ops")
    expect(w.el("st-dg-logs").innerHTML).not.toContain("boom")
    expect(w.el("st-dg-logs").innerHTML).toContain("all good")
    await w.go("#page=settings&section=health")
    expect(es.closed).toBe(true)
    expect(w.writes()).toEqual([])
  })

  it("switches tabs, filters by agent and row count, and reads the doctor checks", async () => {
    const w = open()
    await w.settle()
    await w.click({ "data-st-act": "dg-tab", "data-id": "errors" })
    expect(w.calls.some((c) => c.url === "/api/admin/observability/errors?limit=50")).toBe(true)
    await w.click({ "data-st-act": "dg-tab", "data-id": "routing" })
    expect(settingsHtml(w)).toContain("mention")
    await w.click({ "data-st-act": "dg-tab", "data-id": "rotations" })
    expect(settingsHtml(w)).toContain("210,000")
    await w.click({ "data-st-act": "dg-tab", "data-id": "doctor" })
    const html = settingsHtml(w)
    expect(html).toContain("1 ok · 1 warnings · 0 failing")
    expect(html).toContain("Disk almost full")
    expect(html).toContain("Free some space")
    expect(w.calls.some((c) => c.url === "/api/admin/doctor?running=true")).toBe(true)
    expect(w.writes()).toEqual([])
  })

  it("passes the picked agent and limit to the endpoint", async () => {
    const w = open()
    await w.settle()
    await w.change({ "data-st-dg": "agent" }, false, "cx")
    expect(w.calls.some((c) => c.url === "/api/admin/observability/overview?agent=cx")).toBe(true)
    await w.click({ "data-st-act": "dg-tab", "data-id": "errors" })
    await w.change({ "data-st-dg": "agent" }, false, "ops")
    expect(w.calls.some((c) => c.url === "/api/admin/observability/errors?limit=50&agent=ops")).toBe(true)
    await w.change({ "data-st-dg": "limit" }, false, "200")
    expect(w.calls.some((c) => c.url === "/api/admin/observability/errors?limit=200&agent=ops")).toBe(true)
  })

  it("says why a tab could not be read", async () => {
    const w = open((u) => (u.startsWith("/api/admin/observability/overview") ? { status: 503, body: { error: "operational SQLite not available" } } : undefined))
    await w.settle()
    expect(settingsHtml(w)).toContain("Could not read overview: operational SQLite not available.")
  })
})
