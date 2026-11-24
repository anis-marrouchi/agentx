import { describe, expect, it } from "vitest"
import { wsHeadHtml, wsLast, wsProject } from "../src/daemon/ui/pages/wall-schedules"

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
const when = () => "2 min ago"

// #2101 P10 (mock R7): Hub › Schedules as a table.
describe("wsProject", () => {
  it("shortens a forge issue or MR link to owner/repo#n and keeps the link", () => {
    expect(wsProject({ home: "https://github.com/acme/shop/issues/12" })).toEqual({ label: "acme/shop#12", href: "https://github.com/acme/shop/issues/12" })
    expect(wsProject({ home: "https://gitlab.example.com/grp/app/-/merge_requests/7" }).label).toBe("grp/app#7")
  })
  it("keeps a plain home as text, falls back to the goal id, else nothing", () => {
    expect(wsProject({ home: "grp/app#3" })).toEqual({ label: "grp/app#3", href: "" })
    expect(wsProject({ goal: "noqta#802" })).toEqual({ label: "noqta#802", href: "" })
    expect(wsProject({})).toEqual({ label: "", href: "" })
  })
})

describe("wsLast", () => {
  it("says a failure and its first line, escaped", () => {
    const r = wsLast({ status: "failed", at: "2026-11-24T19:00:00Z", summary: "token <expired>\nstack…" }, esc, when)
    expect(r.failed).toBe(true)
    expect(r.why).toBe("token <expired>")
    expect(r.html).toBe('<span class="wsc__last is-err">Failed <small>2 min ago</small></span>')
  })
  it("counts a timeout as a failure and a success as worked", () => {
    expect(wsLast({ status: "timeout" }, esc, when).failed).toBe(true)
    expect(wsLast({ status: "success", at: "2026-11-24T19:00:00Z" }, esc, when)).toEqual({ html: '<span class="wsc__last is-ok">Worked <small>2 min ago</small></span>', failed: false, why: "" })
  })
  it("says No run yet without a run", () => {
    expect(wsLast(null, esc, when).html).toContain("No run yet")
  })
})

describe("wsHeadHtml", () => {
  it("names the columns in order", () => {
    expect([...wsHeadHtml().matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(["Schedule", "Project", "Next run", "Last result", "Last 7", ""])
  })
})
