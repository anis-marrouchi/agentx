import { describe, expect, it } from "vitest"
import { openWall, settingsHtml, type Route } from "./wall-settings-harness"

// #1449: Settings › Diagnostics has four tabs of classic /admin/health,
// read-only, from the endpoints that page reads.

const ERRORS = { rows: [{ started_at: "2026-10-31T10:00:00Z", agent_id: "cx", channel: "telegram", message_preview: "hi <b>", error: "ETIMEDOUT", plain: "The agent took too long" }] }
const ROUTING = { rows: [{ at: "2026-10-31T10:01:00Z", channel: "telegram", chat_id: "42", kind: "dm", deciding_stage: "mention", agent_id: "cx", reason: "@cx" }] }
const ROTATIONS = { rows: [{ rotated_at: "2026-10-31T10:02:00Z", agent_id: "ops", channel: "slack", reason: "tier-2", last_turn_input_tokens: 210000 }] }
const DOCTOR = { summary: { ok: 1, warnings: 1, errors: 0 }, checks: [
  { group: "Runtime", severity: "ok", title: "Node 22", detail: "" },
  { group: "Runtime", severity: "warn", title: "Disk almost full", detail: "97% used", fix: "Free some space" },
] }

const base: Route = (u) => u.startsWith("/api/admin/observability/errors") ? { status: 200, body: ERRORS }
  : u.startsWith("/api/admin/observability/routing") ? { status: 200, body: ROUTING }
  : u.startsWith("/api/admin/observability/rotations") ? { status: 200, body: ROTATIONS }
  : u.startsWith("/api/admin/doctor") ? { status: 200, body: DOCTOR } : undefined
const open = (route?: Route) => openWall({ hash: "#page=settings&section=diagnostics", route: (u, i) => route?.(u, i) ?? base(u, i) })

describe("Hub Settings: Diagnostics (#1449)", () => {
  it("is listed under Machines and opens on Errors, escaped, with the classic call", async () => {
    const w = open()
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("Errors, routing, rotations and checks")
    expect(html).toContain("The agent took too long")
    expect(html).toContain("hi &lt;b&gt;")
    expect(w.calls.some((c) => c.url === "/api/admin/observability/errors?limit=50")).toBe(true)
    expect(w.writes()).toEqual([])
  })

  it("switches tabs, filters by agent and row count, and reads the doctor checks", async () => {
    const w = open()
    await w.settle()
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
    await w.change({ "data-st-dg": "agent" }, false, "ops")
    expect(w.calls.some((c) => c.url === "/api/admin/observability/errors?limit=50&agent=ops")).toBe(true)
    await w.change({ "data-st-dg": "limit" }, false, "200")
    expect(w.calls.some((c) => c.url === "/api/admin/observability/errors?limit=200&agent=ops")).toBe(true)
  })

  it("says why a tab could not be read", async () => {
    const w = open((u) => (u.startsWith("/api/admin/observability/errors") ? { status: 503, body: { error: "operational SQLite not available" } } : undefined))
    await w.settle()
    expect(settingsHtml(w)).toContain("Could not read errors: operational SQLite not available.")
  })
})
