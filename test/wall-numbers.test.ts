import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { NumberStore } from "../src/numbers/store"
import { DAY_MS, describePeriod, describeTarget, formatValue } from "../src/numbers/model"
import { numbersHubReply, hasNumbersTable, HUB_READINGS } from "../src/numbers/hub-api"
import { syncConfigNumbers } from "../src/numbers/sweep"
import {
  numFmt, numTargetText, numPeriodText, numMerge, numFilter, numGroups, numTagsOf, numTagKinds, numSparkSvg, numRowHtml,
  numDeptCardsHtml, numbersPageHtml, numJobHtml, numSourceText, type HubNumber,
} from "../src/daemon/ui/pages/wall-numbers"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"

// The Hub's Numbers page (#1826 N2): each number's newest reading, its
// trend and status in words, by department, filtered by tag; and a job's
// value line showing the number it names.

const NOW = Date.parse("2026-11-10T09:00:00Z")
const day = (s: string) => Date.parse(`${s}T00:00:00Z`)
const week = (start: string, value: number | null, extra: Record<string, unknown> = {}) =>
  ({ value, error: value === null ? "https://stats.example.com/v could not be reached (ECONNREFUSED)" : null, readAt: NOW, periodStart: day(start), periodEnd: day(start) + 7 * DAY_MS, by: "reader", note: null, ...extra })

const num = (over: Partial<HubNumber>): HubNumber => ({
  id: "views", name: "Video views", ownerAgent: "marketer", unit: "views", target: { value: 1000, direction: "up" }, rhythm: "weekly",
  source: { kind: "manual" }, tags: ["channel:video", "product:shop"], status: "on_target", statusWords: "on target", latest: null, ...over,
})

describe("formatting matches the numbers model", () => {
  it("writes values, targets and windows as the CLI does", () => {
    for (const [v, u] of [[1240, "views"], [12.345, null], [40, "%"], [0, "clients"], [null, "views"]] as const) expect(numFmt(v, u)).toBe(formatValue(v, u))
    expect(numTargetText({ value: 2, direction: "down" }, "h")).toBe(describeTarget({ value: 2, direction: "down" }, "h"))
    const p = { start: day("2026-11-02"), end: day("2026-11-09") }
    expect(numPeriodText(p)).toBe(describePeriod(p))
    expect(numPeriodText({ start: day("2026-11-02"), end: day("2026-11-03") })).toBe("2026-11-02")
  })
})

describe("trend and status", () => {
  it("draws a failed read as a gap, never as 0", () => {
    const svg = numSparkSvg([week("2026-11-02", 1240), week("2026-10-26", null), week("2026-10-19", 900), week("2026-10-12", 800)], "on_target", "views")
    // Two pieces of line: before and after the gap.
    expect(svg.match(/<polyline|<circle r="1.5"/g)!.length).toBe(2)
    expect(svg).toContain("Trend, oldest first: 800 views, 900 views, no reading, 1,240 views")
    expect(svg).not.toMatch(/[\s:]0 views/)
    // One value: no line to draw.
    expect(numSparkSvg([week("2026-11-02", 5)], "on_target", null)).toContain("is-none")
  })

  it("says no reading for a failed newest read, with why in its readings", () => {
    const n = num({ status: "no_reading", statusWords: "no reading", latest: week("2026-11-02", null), readings: [week("2026-11-02", null), week("2026-10-26", 1100)] })
    const html = numRowHtml(n, false)
    expect(html).toContain('<b class="is-none">no reading</b>')
    expect(html).toContain('is-no_reading">no reading</span>')
    expect(html).toContain("could not be reached (ECONNREFUSED)")
    expect(html).not.toMatch(/>0( views)?</)
    expect(html).toContain("2026-11-02..2026-11-08")
    expect(html).toContain("target ≥ 1,000 views")
  })

  it("shows the status words for on target, missed and missed twice", () => {
    for (const [s, w] of [["on_target", "on target"], ["missed", "missed"], ["missed_twice", "missed twice"]]) {
      expect(numRowHtml(num({ status: s, statusWords: w, latest: week("2026-11-02", 10) }), false)).toContain(`wnm__st is-${s}">${w}</span>`)
    }
  })

  it("escapes names, tags and notes", () => {
    const html = numRowHtml(num({ name: "<b>x</b>", tags: ['a"b'], latest: week("2026-11-02", 3, { note: "<script>" }), readings: [week("2026-11-02", 3, { note: "<script>" })] }), true)
    expect(html).not.toContain("<b>x</b>")
    expect(html).not.toContain("<script>")
    expect(html).toContain(" open>")
  })
})

describe("list, tags and groups", () => {
  const list = numMerge([
    { node: "node-a", numbers: [num({}), num({ id: "signups", name: "Sign-ups", ownerAgent: "seller", tags: ["product:shop"], status: "missed_twice", statusWords: "missed twice" })] },
    { node: "node-b", numbers: [num({ id: "reach", name: "Newsletter reach", ownerAgent: "writer", tags: ["channel:newsletter"], status: "no_reading", statusWords: "no reading" })] },
  ])

  it("puts the urgent numbers first and keeps each one's machine", () => {
    expect(list.map((n) => [n.id, n.node])).toEqual([["signups", "node-a"], ["reach", "node-b"], ["views", "node-a"]])
  })

  it("filters by every tag picked and groups by tag kind, owner or department", () => {
    expect(numTagsOf(list)).toEqual(["channel:newsletter", "channel:video", "product:shop"])
    expect(numTagKinds(list)).toEqual(["channel", "product"])
    expect(numFilter(list, ["product:shop"]).map((n) => n.id)).toEqual(["signups", "views"])
    expect(numFilter(list, ["product:shop", "channel:video"]).map((n) => n.id)).toEqual(["views"])
    expect(numGroups(list, "tag:channel", {}).map((g) => [g.label, g.numbers.length])).toEqual([["channel: newsletter", 1], ["channel: video", 1], ["No channel tag", 1]])
    expect(numGroups(list, "owner", {}).map((g) => g.label)).toEqual(["@marketer", "@seller", "@writer"])
    const deptOf = { marketer: { id: "growth", name: "Growth" }, seller: { id: "growth", name: "Growth" } }
    expect(numGroups(list, "department", deptOf).map((g) => [g.label, g.numbers.map((n) => n.id)])).toEqual([["Growth", ["signups", "views"]], ["Not in a department", ["reach"]]])
  })

  it("has a card per department that counts and names the urgent numbers", () => {
    const html = numDeptCardsHtml(list, { marketer: { id: "growth", name: "Growth" }, seller: { id: "growth", name: "Growth" } })
    expect(html).toContain('aria-label="Numbers by department"')
    expect(html).toContain("Growth <small>2 numbers</small>")
    expect(html).toContain('is-missed_twice">1 missed twice</span>')
    expect(html).toContain('href="#page=numbers&amp;num=signups">Sign-ups</a> missed twice')
    expect(html).toContain("Not in a department <small>1 number</small>")
    // No departments in the org: a card per owner.
    expect(numDeptCardsHtml(list, {})).toContain('aria-label="Numbers by owner"')
  })

  it("draws the page: counts, chips with their state, group by, and an empty state", () => {
    const html = numbersPageHtml({ list, tags: ["product:shop"], by: "owner", open: "", deptOf: {}, missed: [{ name: "node-c", why: "does not answer" }] })
    expect(html).toContain('<div class="is-missed_twice"><dt>missed twice</dt><dd>1</dd></div>')
    expect(html).toContain('data-ntag="product:shop" aria-pressed="true"')
    expect(html).toContain('data-ntag="channel:video" aria-pressed="false"')
    expect(html).toContain('<option value="owner" selected>owner</option>')
    expect(html).toContain('<option value="tag:channel">tag channel</option>')
    expect(html).toContain("Not read: node-c does not answer.")
    expect(html).not.toContain("Newsletter reach")
    expect(numbersPageHtml({ list: [], tags: [], by: "", open: "", deptOf: {}, missed: [] })).toContain("No numbers yet.")
    expect(numbersPageHtml({ list: null, tags: [], by: "", open: "", deptOf: {}, missed: [] })).toContain("Loading…")
  })

  it("shows a job's number with its newest reading and status", () => {
    const n = num({ latest: week("2026-11-02", 1240) })
    expect(numJobHtml("views", n, true)).toContain('Number: <a href="#page=numbers&amp;num=views">Video views</a> <b>1,240 views</b>')
    expect(numJobHtml("views", num({ status: "no_reading", statusWords: "no reading", latest: week("2026-11-02", null) }), true)).toContain("<b>no reading</b>")
    expect(numJobHtml("gone", null, true)).toContain("not found")
    expect(numJobHtml("", null, true)).toBe("")
  })
})

describe("GET /api/admin/numbers", () => {
  let tmp: string
  let db: Database.Database
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "agentx-hub-numbers-")); db = new Database(path.join(tmp, "db.sqlite")) })
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })

  it("is empty and writes nothing on a machine with no numbers", () => {
    expect(numbersHubReply(db, NOW)).toEqual({ count: 0, numbers: [], funnels: [] })
    expect(hasNumbersTable(db)).toBe(false)
    expect(numbersHubReply(null, NOW)).toEqual({ count: 0, numbers: [], funnels: [] })
  })

  it("sends each number's recent readings, a failed read as no reading, and masks sources", () => {
    const store = new NumberStore(db)
    expect(syncConfigNumbers(store, {
      web: { name: "Web", source: { kind: "http-json", url: "https://stats.example.com/v?key=SECRET-a", path: "v", headers: { Authorization: "SECRET-b" } } },
      cmd: { name: "Cmd", source: { kind: "command", command: "echo SECRET-c", path: "" } },
    }, NOW)).toEqual([])
    for (let i = 0; i < 15; i++) store.record({ numberId: "web", value: 100 + i, readAt: NOW, periodStart: day("2026-01-05") + i * 7 * DAY_MS, periodEnd: day("2026-01-12") + i * 7 * DAY_MS, by: "reader" })
    store.record({ numberId: "cmd", value: null, error: "the command exited with code 4", readAt: NOW, periodStart: day("2026-11-02"), periodEnd: day("2026-11-09"), by: "reader" })
    const reply = numbersHubReply(db, NOW) as any
    expect(reply.count).toBe(2)
    const web = reply.numbers.find((n: any) => n.id === "web")
    expect(web.readings).toHaveLength(HUB_READINGS)
    const cmd = reply.numbers.find((n: any) => n.id === "cmd")
    expect(cmd.status).toBe("no_reading")
    expect(cmd.latest.value).toBeNull()
    expect(JSON.stringify(reply)).not.toContain("SECRET")
    expect(numSourceText(web.source)).toContain("key=***")
  })
})

// --- The page's real script, against a stubbed DOM and fetch ---

const LIVE = { nodes: [{ name: "node-a", url: "http://node-a", reachable: true, agents: [{ id: "marketer", name: "Marketer" }],
  crons: [{ id: "weekly-video", agent: "marketer", schedule: "0 9 * * 1", enabled: true, value: { why: "Grows the audience", metric: "Weekly views at least 1000", number: "views" } }] }] }

function openWall(hash: string, numbers: unknown) {
  const page = renderWallPage()
  const script = CRON_VALUE_SCRIPT + "\n" + WALL_PAGE_SCRIPT
  const els = new Map<string, any>()
  const classes = () => { const s = new Set<string>(); return { toggle: (c: string, on?: boolean) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c) }, contains: (c: string) => s.has(c), add: (c: string) => s.add(c), remove: (c: string) => s.delete(c) } }
  const attrsOf = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"')]))
  const make = (id: string, tag: string) => {
    let html = ""
    const e: any = {
      id, attrs: attrsOf(tag), hidden: /\shidden[\s>]/.test(tag), textContent: "", value: id === "f-status" ? "open" : "", checked: false,
      type: /type="checkbox"/.test(tag) ? "checkbox" : "select", style: {}, classList: classes(), parentNode: { classList: classes() },
      get innerHTML() { return html },
      set innerHTML(v: string) { html = v; for (const m of v.matchAll(/<(\w+)\b[^>]*\sid="([^"]+)"[^>]*>/g)) els.set(m[2], make(m[2], m[0])) },
      getAttribute: (k: string) => e.attrs[k] ?? null, setAttribute: (k: string, v: string) => { e.attrs[k] = v },
      hasAttribute: (k: string) => k in e.attrs, removeAttribute: (k: string) => { delete e.attrs[k] },
      addEventListener: () => {}, appendChild: (c: any) => c, querySelector: () => null,
    }
    return e
  }
  const el = (id: string) => {
    if (!els.has(id)) {
      const tag = new RegExp(`<[^>]*\\sid="${id}"[^>]*>`).exec(page)
      if (!tag) throw new Error(`no element #${id} on the page`)
      els.set(id, make(id, tag[0]))
    }
    return els.get(id)
  }
  const onDoc: Record<string, Array<(ev: any) => void>> = {}
  const onWindow: Record<string, () => void> = {}
  const doc = {
    getElementById: el, hidden: false,
    querySelector: (sel: string) => (sel === ".ax-wall" ? { classList: classes() } : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (ev: any) => void) => { (onDoc[t] ??= []).push(f) },
    createElement: () => ({ className: "", innerHTML: "", setAttribute() {}, querySelector: () => ({ setAttribute() {}, innerHTML: "" }) }),
  }
  const loc: any = { hash, search: "", href: "" }
  const calls: string[] = []
  const fetchStub = (url: string) => {
    calls.push(url)
    if (url === "/api/admin/numbers") return numbers === 404 ? Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) : Promise.resolve({ ok: true, status: 200, json: async () => numbers })
    const body = url.startsWith("/api/admin/wall?") ? { node: "node-a", syncedAt: NOW, nodes: [{ name: "node-a", ok: true }], failures: [], posts: [] }
      : url === "/api/live?quick=1" ? LIVE : { runs: [] }
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", "EventSource", "requestAnimationFrame", script)(
    doc, { addEventListener: (t: string, f: () => void) => { onWindow[t] = f } }, fetchStub, loc,
    { replaceState: (_: unknown, __: string, h: string) => { loc.hash = h } },
    { getItem: () => null, setItem: () => {} }, () => 0, class { addEventListener() {} close() {} }, (f: () => void) => { f(); return 1 },
  )
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  const click = async (attrs: Record<string, string>) => {
    const t: any = { attrs, getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs }
    t.closest = (sel: string) => [...sel.matchAll(/\[([\w-]+)\]/g)].some((m) => m[1] in attrs) ? t : null
    for (const f of onDoc.click ?? []) f({ target: t, preventDefault() {} })
    await settle()
  }
  const pick = async (id: string, value: string) => { for (const f of onDoc.change ?? []) f({ target: { id, value } }); await settle() }
  return { el, calls, settle, loc, click, pick }
}

const REPLY = { count: 2, numbers: [
  num({ latest: week("2026-11-02", 1240), readings: [week("2026-11-02", 1240), week("2026-10-26", 980)] }),
  num({ id: "signups", name: "Sign-ups", tags: ["product:shop"], status: "no_reading", statusWords: "no reading", latest: week("2026-11-02", null) }),
] }

describe("the Hub's Numbers page", () => {
  it("has a nav entry, hidden until a machine has a number", () => {
    const page = renderWallPage()
    expect(page).toMatch(/data-nav="numbers" href="#page=numbers" hidden/)
    expect(page).toContain('id="wall-numbers"')
  })

  it("opens on #page=numbers and lists the numbers with status and trend", async () => {
    const w = openWall("#page=numbers", REPLY)
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Numbers")
    expect(w.el("wall-numbers").hidden).toBe(false)
    const html = w.el("wall-numbers").innerHTML as string
    expect(html).toContain("<b>Video views</b>")
    expect(html).toContain("<b>1,240 views</b>")
    expect(html).toContain('<b class="is-none">no reading</b>')
    expect(html).toContain('<svg class="wnm__spark is-on_target"')
    // The nav count: numbers missed or without a reading.
    expect(w.el("nav-n-numbers").textContent).toBe("1")
  })

  it("keeps the tags and grouping in the link", async () => {
    const w = openWall("#page=numbers", REPLY)
    await w.settle()
    await w.click({ "data-ntag": "product:shop" })
    expect(w.loc.hash).toContain("n-tags=product%3Ashop")
    await w.pick("n-by", "owner")
    expect(w.loc.hash).toContain("n-by=owner")
    expect(w.el("wall-numbers").innerHTML).toContain('<h3 class="wnm__gh">@marketer')
  })

  it("shows an empty page with how to add one, and treats an older machine as having none", async () => {
    const w = openWall("#page=numbers", 404)
    await w.settle()
    expect(w.el("wall-numbers").innerHTML).toContain("No numbers yet.")
    expect(w.el("nav-n-numbers").textContent).toBe("0")
  })

  it("has a Funnels tab once a machine sets a funnel up, kept in the link (#1826 N4)", async () => {
    const plain = openWall("#page=numbers", REPLY)
    await plain.settle()
    expect(plain.el("wall-numbers").innerHTML).not.toContain("data-nview")
    const w = openWall("#page=numbers", { ...REPLY, funnels: [{ id: "shop", name: "Shop journey", steps: ["views", "signups"] }] })
    await w.settle()
    expect(w.el("wall-numbers").innerHTML).toContain('data-nview="funnels"')
    await w.click({ "data-nview": "funnels" })
    expect(w.loc.hash).toContain("n-view=funnels")
    const html = w.el("wall-numbers").innerHTML as string
    expect(html).toContain('aria-label="Funnel: Shop journey"')
    expect(html).toContain('<span class="wfn__name">Video views</span><b>1,240 views</b>')
    expect(html).toContain("no conversion: a step has no reading")
  })

  it("shows a job's number and its newest reading on Jobs", async () => {
    const w = openWall("#status=open&view=jobs", REPLY)
    await w.settle()
    expect(w.calls).toContain("/api/admin/numbers")
    expect(w.el("wall-jobs").innerHTML).toContain('Number: <a href="#page=numbers&amp;num=views">Video views</a> <b>1,240 views</b>')
  })
})
