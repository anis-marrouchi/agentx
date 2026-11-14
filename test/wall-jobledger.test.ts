import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { JobStore } from "../src/jobs/store"
import { JOBS_HUB_PATH, isJobsHubPath, jobsHubReply } from "../src/jobs/hub-api"
import { jlHomeHtml, jlRowHtml, jlSpan, jlTitle, jlTone, jobLedgerPageHtml, type HubJob } from "../src/daemon/ui/pages/wall-jobledger"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"

// The Hub's Jobs page (#1861): one row per piece of assigned work with the
// status line the daemon derived, chips by state, a door filter, and the
// tree (runs, parent, children) under an opened row.

const NOW = Date.parse("2026-11-14T10:00:00Z")
const HOUR = 3_600_000

const job = (over: Partial<HubJob>): HubJob => ({
  id: "job-1", door: "a2a", state: "working", status: "working, last tool call 40 s ago", requester: "pm", assignee: "coder",
  text: "build the report", headline: null, home: null, parentId: null, updatedAt: NOW - HOUR, createdAt: NOW - 2 * HOUR, ownerRequest: false, ...over,
})

describe("GET /api/admin/job-ledger", () => {
  let tmp: string
  let db: Database.Database
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "agentx-hub-jobs-")); db = new Database(path.join(tmp, "db.sqlite")) })
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })
  const q = (s = "") => new URLSearchParams(s)

  it("knows its own paths, and not the cost ledger's", () => {
    expect(isJobsHubPath(JOBS_HUB_PATH)).toBe(true)
    expect(isJobsHubPath(JOBS_HUB_PATH + "/job-1")).toBe(true)
    expect(isJobsHubPath("/api/admin/ledger/costs")).toBe(false)
    expect(isJobsHubPath("/api/admin/job-ledgers")).toBe(false)
  })

  it("lists the jobs with a status line and the counts, and filters like /jobs", () => {
    const store = new JobStore(db)
    store.open({ id: "job-1", door: "a2a", requester: "pm", assignee: "coder", channel: "a2a", chatId: "pm", text: "build the report", now: NOW - HOUR })
    store.open({ id: "job-2", door: "cron", requester: "cron:nightly", assignee: "ops", channel: "cron", chatId: "nightly", text: "check the backups", parentId: "job-1", now: NOW })
    const reply = jobsHubReply(db, JOBS_HUB_PATH, q(), NOW)
    expect(reply.status).toBe(200)
    const body = reply.body as any
    expect(body.jobs.map((j: any) => j.id)).toEqual(["job-2", "job-1"])
    expect(body.total).toBe(2)
    expect(body.counts.working).toBe(2)
    for (const j of body.jobs) expect(typeof j.status).toBe("string")
    expect((jobsHubReply(db, JOBS_HUB_PATH, q("door=cron"), NOW).body as any).jobs.map((j: any) => j.id)).toEqual(["job-2"])
    expect((jobsHubReply(db, JOBS_HUB_PATH, q("state=done"), NOW).body as any).jobs).toEqual([])
    expect(jobsHubReply(db, JOBS_HUB_PATH, q("state=nope"), NOW).status).toBe(400)
  })

  it("sends one job with its runs, parent and children, and 404 for one it does not have", () => {
    const store = new JobStore(db)
    store.open({ id: "job-1", door: "a2a", requester: "pm", assignee: "coder", channel: "a2a", chatId: "pm", text: "build the report", runId: "run-1", now: NOW - HOUR })
    store.open({ id: "job-2", door: "a2a", requester: "coder", assignee: "ops", channel: "a2a", chatId: "coder", text: "deploy it", parentId: "job-1", now: NOW })
    const one = jobsHubReply(db, JOBS_HUB_PATH + "/job-1", q(), NOW)
    expect(one.status).toBe(200)
    const body = one.body as any
    expect(body.job.id).toBe("job-1")
    expect(body.runs.map((r: any) => r.runId)).toEqual(["run-1"])
    expect(body.parent).toBeNull()
    expect(body.children.map((c: any) => c.id)).toEqual(["job-2"])
    expect((jobsHubReply(db, JOBS_HUB_PATH + "/job-2", q(), NOW).body as any).parent.id).toBe("job-1")
    expect(jobsHubReply(db, JOBS_HUB_PATH + "/gone", q(), NOW).status).toBe(404)
  })

  it("answers 503 without a database and 404 for another path", () => {
    expect(jobsHubReply(null, JOBS_HUB_PATH, q(), NOW).status).toBe(503)
    expect(jobsHubReply(db, "/api/admin/ledger/costs", q(), NOW).status).toBe(404)
  })
})

describe("the rows", () => {
  const opts = { open: false, detail: null, detailErr: "", multi: false, now: NOW }

  it("titles a job by its headline, else the start of its text", () => {
    expect(jlTitle(job({ headline: "Ship the report" }))).toBe("Ship the report")
    const long = jlTitle(job({ text: "word ".repeat(60) }))
    expect(long.length).toBeLessThanOrEqual(100)
    expect(long.endsWith("…")).toBe(true)
    expect(jlTitle(job({ text: "" }))).toBe("job-1")
  })

  it("gives the status line a tone by state, and reads an unheld job as stalled", () => {
    expect(jlTone(job({}))).toBe("working")
    expect(jlTone(job({ state: "blocked", status: "blocked: no access" }))).toBe("blocked")
    expect(jlTone(job({ state: "stalled", status: "stalled, run ended 3 h ago with no state" }))).toBe("stalled")
    expect(jlTone(job({ status: "nobody on it, run ended 3 h ago with no state" }))).toBe("stalled")
    expect(jlRowHtml(job({ state: "stalled", status: "stalled, run ended 3 h ago with no state" }), opts)).toContain('<span class="wjl__st is-stalled">stalled, run ended 3 h ago with no state</span>')
  })

  it("links the home only when it is a web address", () => {
    expect(jlHomeHtml({ kind: "issue", link: "https://git.example.com/shop/-/issues/12" })).toContain('<a href="https://git.example.com/shop/-/issues/12" target="_blank" rel="noopener noreferrer">git.example.com/shop/-/issues/12</a>')
    expect(jlHomeHtml({ kind: "issue", link: "javascript:alert(1)" })).toBe("javascript:alert(1)")
    expect(jlHomeHtml({ kind: "issue", link: "shop#12" })).toBe("shop#12")
    expect(jlHomeHtml(null)).toBe("")
  })

  it("shows who asked whom, the door, when it moved, and tags an owner request", () => {
    const html = jlRowHtml(job({ ownerRequest: true, door: "owner", requester: "owner" }), opts)
    expect(html).toContain("owner → @coder")
    expect(html).toContain("<span>Owner</span>")
    expect(html).toContain("60 min ago</time>")
    expect(html).toContain('<span class="wjl__tag">Your request</span> <a href="#status=open&amp;view=decide" data-dkind="requests">See it in Requests</a>')
    expect(jlRowHtml(job({}), opts)).not.toContain("Your request")
    expect(jlRowHtml(job({}), opts)).toContain("<span>Agent hand-off</span>")
    expect(jlSpan(40_000)).toBe("40 s")
  })

  it("escapes every piece of job text", () => {
    const bad = job({ id: 'a"b', headline: "<script>alert(1)</script>", text: "<img src=x>", status: "<b>working</b>", requester: "<i>pm</i>", assignee: "<u>c</u>", home: { kind: "issue", link: "<script>x</script>" } })
    const html = jlRowHtml(bad, { ...opts, open: true, detail: { job: bad, runs: [{ runId: "<r>", status: "<s>", startedAt: NOW, finishedAt: null, costUsd: null, error: "<e>" }], parent: bad, children: [bad] } })
    for (const raw of ["<script>", "<img", "<b>working", "<i>pm", "<u>c", "<r>", "<s>", "<e>", 'a"b']) expect(html).not.toContain(raw)
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("opens only the row on the machine it was opened on when two machines keep the same id", () => {
    const row = (node: string): any => ({ id: "job-dlg-1", door: "a2a", state: "working", status: "working", requester: "coder", assignee: "devops", text: "deploy", headline: null, home: null, parentId: null, updatedAt: NOW, node, nodeName: node || "here" })
    const model = { list: [row(""), row("clawd")], counts: null, total: 2, state: "open", door: "", open: "job-dlg-1", detail: null, detailErr: "", missed: [], error: "", multi: true, now: NOW }
    const here = jobLedgerPageHtml({ ...model, node: "" })
    expect(here).toContain('data-jlopen="job-dlg-1" data-jlnode="" aria-expanded="true"')
    expect(here).toContain('data-jlopen="job-dlg-1" data-jlnode="clawd" aria-expanded="false"')
    const there = jobLedgerPageHtml({ ...model, node: "clawd" })
    expect(there).toContain('data-jlopen="job-dlg-1" data-jlnode="" aria-expanded="false"')
    expect(there).toContain('data-jlopen="job-dlg-1" data-jlnode="clawd" aria-expanded="true"')
  })

  it("counts the chips from the counts, and says so in one sentence when there is nothing", () => {
    const base = { list: [], counts: { working: 2, continue: 1, waiting: 0, blocked: 1, stalled: 1, done: 7, dropped: 1 }, total: 0, state: "open", door: "", open: "", detail: null, detailErr: "", missed: [], error: "", multi: false, now: NOW }
    const html = jobLedgerPageHtml(base)
    expect(html).toContain('data-jlstate="open" class="is-open" aria-pressed="true">Open <span class="n">5</span>')
    expect(html).toContain('data-jlstate="continue" class="is-continue" aria-pressed="false">Sleeping <span class="n">1</span>')
    expect(html).toContain('data-jlstate="all" class="is-all" aria-pressed="false">All <span class="n">13</span>')
    expect(html).toContain("No open jobs: no assigned work is unfinished.")
    expect(jobLedgerPageHtml({ ...base, state: "done", door: "cron" })).toContain('<option value="cron" selected>Cron</option>')
    expect(jobLedgerPageHtml({ ...base, state: "done" })).toContain("No jobs match this state and door.")
    expect(jobLedgerPageHtml({ ...base, list: null })).toContain("Loading…")
    expect(jobLedgerPageHtml({ ...base, missed: [{ name: "node-b", why: "does not answer" }] })).toContain("Not read: node-b does not answer.")
  })
})

// --- The page's real script, against a stubbed DOM and fetch ---

const LIST = {
  jobs: [
    job({ id: "job-2", headline: "Deploy the report", state: "stalled", status: "stalled, run ended 3 h ago with no state", requester: "coder", assignee: "ops", parentId: "job-1", updatedAt: NOW - 3 * HOUR }),
    job({ id: "job-1", text: "build the report <script>alert(1)</script>", home: { kind: "issue", link: "https://git.example.com/shop/-/issues/12" } }),
    job({ id: "req-1", door: "owner", state: "continue", status: "sleeping until 18:00 for the build", requester: "owner", ownerRequest: true, updatedAt: NOW - 2 * HOUR }),
  ],
  total: 3,
  counts: { working: 1, continue: 1, waiting: 0, blocked: 0, stalled: 1, done: 4, dropped: 0 },
}
const DETAIL = {
  job: LIST.jobs[1],
  runs: [{ runId: "run-1", linkedAt: NOW - 2 * HOUR, status: "completed", startedAt: NOW - 2 * HOUR, finishedAt: NOW - 2 * HOUR + 12 * 60_000, costUsd: 0.4, error: null }],
  parent: job({ id: "job-0", headline: "Weekly report", assignee: "pm", status: "waiting on coder until 19:00", state: "waiting" }),
  children: [LIST.jobs[0]],
}

function openWall(hash: string, list: unknown = LIST) {
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
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body })
    const no = (status: number) => Promise.resolve({ ok: false, status, json: async () => ({}) })
    if (url.startsWith("/api/admin/job-ledger?")) return list === 404 ? no(404) : list === 500 ? no(500) : ok(list)
    if (url === "/api/admin/job-ledger/job-1") return ok(DETAIL)
    if (url.startsWith("/api/admin/job-ledger/")) return no(404)
    const body = url.startsWith("/api/admin/wall?") ? { node: "node-a", syncedAt: NOW, nodes: [{ name: "node-a", ok: true }], failures: [], posts: [] }
      : url === "/api/live?quick=1" ? { nodes: [{ name: "node-a", url: "http://node-a", reachable: true, agents: [], crons: [] }] } : { runs: [] }
    return ok(body)
  }
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", "EventSource", "requestAnimationFrame", script)(
    doc, { addEventListener: () => {} }, fetchStub, loc,
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
  return { el, calls, settle, loc, click, pick, html: () => el("wall-jobledger").innerHTML as string }
}

describe("the Hub's Jobs page", () => {
  it("has a Jobs nav entry of its own, and the cron page is now Schedules", () => {
    const page = renderWallPage()
    expect(page).toMatch(/data-nav="jobledger" href="#page=jobledger"[^>]*>.*?<span>Jobs<\/span>/)
    expect(page).toMatch(/data-nav="jobs" href="#status=open&amp;view=jobs"[^>]*>.*?<span>Schedules<\/span>/)
    expect(page).toContain('id="wall-jobledger"')
  })

  it("opens on #page=jobledger with the open jobs, each with its status line", async () => {
    const w = openWall("#page=jobledger")
    await w.settle()
    expect(w.el("wall-title").textContent).toBe("Jobs")
    expect(w.el("wall-jobledger").hidden).toBe(false)
    expect(w.calls).toContain("/api/admin/job-ledger?state=open")
    const html = w.html()
    expect(html).toContain('<span class="wjl__h">Deploy the report</span><span class="wjl__st is-stalled">stalled, run ended 3 h ago with no state</span>')
    expect(html).toContain('<span class="wjl__st is-working">working, last tool call 40 s ago</span>')
    expect(html).toContain('<span class="wjl__st is-continue">sleeping until 18:00 for the build</span>')
    expect(html).toContain("coder → @ops")
    expect(html).toContain('<a href="https://git.example.com/shop/-/issues/12"')
    expect(html).toContain("Your request")
    // Most recently active first.
    expect([...html.matchAll(/class="wjl__row" data-jlopen="([\w-]+)"/g)].map((m) => m[1])).toEqual(["job-1", "req-1", "job-2"])
    // The nav count: jobs stalled or blocked.
    expect(w.el("nav-n-jobledger").textContent).toBe("1")
  })

  it("never puts job text on the page as HTML", async () => {
    const w = openWall("#page=jobledger&job=job-1")
    await w.settle()
    expect(w.html()).not.toContain("<script>")
    expect(w.html()).toContain("build the report &lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("asks for the state a chip names and the door picked, and keeps both in the link", async () => {
    const w = openWall("#page=jobledger")
    await w.settle()
    await w.click({ "data-jlstate": "stalled" })
    expect(w.calls).toContain("/api/admin/job-ledger?state=stalled")
    expect(w.loc.hash).toContain("j-state=stalled")
    expect(w.html()).toContain('data-jlstate="stalled" class="is-stalled" aria-pressed="true"')
    await w.pick("jl-door", "a2a")
    expect(w.calls).toContain("/api/admin/job-ledger?state=stalled&door=a2a")
    expect(w.loc.hash).toContain("j-door=a2a")
    await w.click({ "data-jlstate": "all" })
    expect(w.calls).toContain("/api/admin/job-ledger?state=all&door=a2a")
    const linked = openWall("#page=jobledger&j-state=done&j-door=cron")
    await linked.settle()
    expect(linked.calls).toContain("/api/admin/job-ledger?state=done&door=cron")
  })

  it("opens a row on its details: full text, runs, parent and children", async () => {
    const w = openWall("#page=jobledger")
    await w.settle()
    expect(w.calls.some((u) => u.startsWith("/api/admin/job-ledger/"))).toBe(false)
    await w.click({ "data-jlopen": "job-1", "data-jlnode": "" })
    expect(w.calls).toContain("/api/admin/job-ledger/job-1")
    expect(w.loc.hash).toContain("job=job-1")
    const html = w.html()
    expect(html).toContain('data-jlopen="job-1" data-jlnode="" aria-expanded="true"')
    expect(html).toContain("<td><code>run-1</code></td><td>completed</td>")
    expect(html).toContain("<td>12 min</td><td>$0.40</td>")
    expect(html).toContain('<span class="k">Part of</span> <button type="button" class="wjl__link" data-jlopen="job-0" data-jlnode="">Weekly report</button>')
    expect(html).toContain('<li><button type="button" class="wjl__link" data-jlopen="job-2" data-jlnode="">Deploy the report</button>')
    // Selecting it again closes it.
    await w.click({ "data-jlopen": "job-1", "data-jlnode": "" })
    expect(w.loc.hash).not.toContain("job=")
    expect(w.html()).not.toContain("wjl__runs")
  })

  it("says so when the opened job is gone", async () => {
    const w = openWall("#page=jobledger&job=job-9")
    await w.settle()
    expect(w.html()).toContain("Could not read this job: it is no longer in the ledger.")
  })

  it("has one plain sentence when there are no jobs, on an older machine too", async () => {
    const w = openWall("#page=jobledger", { jobs: [], total: 0, counts: {} })
    await w.settle()
    expect(w.html()).toContain("No open jobs: no assigned work is unfinished.")
    const old = openWall("#page=jobledger", 404)
    await old.settle()
    expect(old.html()).toContain("No open jobs: no assigned work is unfinished.")
  })

  it("names the machine when the read fails", async () => {
    const w = openWall("#page=jobledger", 500)
    await w.settle()
    expect(w.html()).toContain("Could not read the jobs: node-a answered with an error.")
  })

  it("does not read the ledger on other pages", async () => {
    const w = openWall("#page=activity")
    await w.settle()
    expect(w.calls.some((u) => u.startsWith("/api/admin/job-ledger"))).toBe(false)
    expect(w.el("wall-jobledger").hidden).toBe(true)
  })
})
