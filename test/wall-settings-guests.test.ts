import { describe, expect, it } from "vitest"
import { openWall, settingsHtml, type Route } from "./wall-settings-harness"
import { wallGuestsTarget } from "../src/daemon/wall-actions"

// #1449: Settings › Guests has the grants classic /guests showed, with Pause,
// Resume and End, written under the Wall's owner guard.

const grant = (over: Record<string, unknown>) => ({
  id: "g-1", name: "Support <Co>", guest: "Company X", agentId: "cx", state: "active", level: "propose",
  expiresAt: "2026-11-30T00:00:00Z", folders: ["/srv/app"], skills: [], commands: ["git"],
  usage: { turns: 3, tokens: 1200, lastAt: "2026-10-31T10:00:00Z" }, guestNode: { name: "x-mac" },
  trail: [{ at: "2026-10-30T09:00:00Z", event: "joined", detail: "<b>x-mac</b>" }], ...over,
})
const GRANTS = { grants: [grant({}), grant({ id: "g-2", name: "Paused one", state: "paused" }), grant({ id: "g-3", name: "Old one", state: "ended" })] }

const base: Route = (u, i) => u === "/api/guests" ? { status: 200, body: GRANTS }
  : i?.method === "POST" && u.startsWith("/api/admin/wall/settings/guests/") ? { status: 200, body: { grant: { name: "Support <Co>", state: "paused" }, stopped: 1 } }
  : undefined
const open = (route?: Route) => openWall({ hash: "#page=settings&section=guests", route: (u, i) => route?.(u, i) ?? base(u, i) })

describe("Hub Settings: Guests (#1449)", () => {
  it("lists every grant, escaped, with the buttons its state allows", async () => {
    const w = open()
    await w.settle()
    const html = settingsHtml(w)
    expect(html).toContain("<h2>Guests</h2>")
    expect(html).toContain("Support &lt;Co&gt;")
    expect(html).toContain("&lt;b&gt;x-mac&lt;/b&gt;")
    expect(html).toContain("Guest: Company X (x-mac) · agent cx · until 2026-11-30 · 3 turn(s), 1200 tokens")
    expect(html).toContain("propose: no merge, deploy or delete · folders /srv/app · skills none · commands git")
    expect(html).toContain('data-op="pause" data-id="g-1"')
    expect(html).toContain('data-op="resume" data-id="g-2"')
    expect(html).not.toContain('data-key="guest:g-3"')
    expect(w.calls.some((c) => c.url === "/api/guests")).toBe(true)
    expect(w.writes()).toEqual([])
  })

  it("pauses under the owner guard, and ends only after a yes", async () => {
    const w = open()
    await w.settle()
    await w.click({ "data-st-act": "gu", "data-op": "pause", "data-id": "g-1" })
    expect(w.writes().map((c) => [c.method, c.url])).toEqual([["POST", "/api/admin/wall/settings/guests/g-1/pause"]])
    expect(settingsHtml(w)).toContain("Support &lt;Co&gt;: paused, 1 running turn(s) stopped.")
    await w.click({ "data-st-act": "ask", "data-key": "guest:g-1" })
    expect(settingsHtml(w)).toContain("for good? The guest loses access at once.")
    expect(w.writes()).toHaveLength(1)
    await w.click({ "data-st-act": "confirm", "data-key": "guest:g-1" })
    expect(w.writes().map((c) => c.url)).toContain("/api/admin/wall/settings/guests/g-1/end")
  })

  it("says so when the grants cannot be read, and keeps a refusal's reason", async () => {
    const w = open((u, i) => u === "/api/guests" ? { status: 502, body: { error: "daemon unreachable" } }
      : i?.method === "POST" ? { status: 401, body: { error: "Only the owner writes" } } : undefined)
    await w.settle()
    expect(settingsHtml(w)).toContain("Could not read the grants: daemon unreachable.")
    await w.click({ "data-st-act": "gu", "data-op": "resume", "data-id": "g-2" })
    // A failed write only writes its note line, in place.
    expect(w.el("st-n-gu").textContent).toBe("Not done: Only the owner writes")
  })

  it("maps only pause, resume and end to the classic guests call", () => {
    expect(wallGuestsTarget("POST", "/api/admin/wall/settings/guests/g-1/end")).toBe("/api/guests/g-1/end")
    expect(wallGuestsTarget("POST", "/api/admin/wall/settings/guests/g-1/update")).toBeNull()
    expect(wallGuestsTarget("GET", "/api/admin/wall/settings/guests/g-1/pause")).toBeNull()
    expect(wallGuestsTarget("POST", "/api/admin/wall/settings/guests/a/b/pause")).toBeNull()
  })
})
