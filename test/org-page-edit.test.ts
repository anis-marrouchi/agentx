import { describe, it, expect } from "vitest"
import { renderOrgPage } from "../src/daemon/ui/pages/org"
import { orgConfirmFor } from "../src/daemon/ui/pages/org-setup"
import { applyOrgEdit, orgChoices, readOrgSetup } from "../src/business/org-edit"

// Edit org on /org (#1420): owner only, with a confirm step for moves and
// removals (#1463 section 5). The page's own script runs against a small
// stand-in DOM; its POSTs go through the real applyOrgEdit on a config in
// memory, so a test can check what was saved, or that nothing was.

const schedule = { days: ["mon"], start: "08:00", end: "12:00" }
function base(): any {
  return {
    node: { id: "n", name: "n" },
    agents: { lead: { name: "Lead" }, pm: { name: "PM" }, dev: { name: "Dev" } },
    people: [{ id: "sam", name: "Sam Doe", role: "owner" }, { id: "kim", name: "Kim Roe" }],
    business: {
      roles: { boss: { title: "Chief" }, eng: { title: "Engineer" } },
      orgChart: {
        lead: { role: "boss", schedule, utilizationTarget: 0.5 },
        pm: { role: "eng", reportsTo: "lead", schedule, utilizationTarget: 0.8 },
      },
    },
  }
}

function openOrg(opts: { owner?: boolean; hash?: string; cfg?: any; refuse?: (body: any) => string | null } = {}) {
  const owner = opts.owner !== false
  const cfg = opts.cfg ?? base()
  const page = renderOrgPage()
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("withPeople"))!
  const els = new Map<string, any>()
  const el = (id: string) => {
    if (!els.has(id)) {
      const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(page) ?? (/^oe-/.test(id) ? [`<x id="${id}">`] : null)
      if (!tag) return null
      const attrs: Record<string, string> = {}
      let html = ""
      els.set(id, {
        id, hidden: /\shidden[\s>]/.test(tag[0]), textContent: "", className: "", value: "", disabled: false, focused: false,
        get innerHTML() { return html },
        // As in a browser, new markup replaces the fields it draws.
        set innerHTML(v: string) {
          html = v
          for (const m of v.matchAll(/<(input|select)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
            if (!els.has(m[2])) continue
            els.get(m[2]).value = m[1] === "input" ? (/\bvalue="([^"]*)"/.exec(m[0])?.[1] ?? "") : (/<option value="([^"]*)"/.exec(v.slice(m.index!))?.[1] ?? "")
          }
        },
        setAttribute: (k: string, v: string) => { attrs[k] = v },
        getAttribute: (k: string) => attrs[k],
        focus() { this.focused = true },
        addEventListener() {},
      })
    }
    return els.get(id)
  }
  const onDoc: Record<string, Array<(ev: any) => void>> = {}
  // Day boxes (#1715): drawn from the panel's markup; a test ticks them in `ticked`.
  const ticked = new Map<string, boolean>()
  const querySelectorAll = (sel: string) => {
    const name = /name="([^"]+)"/.exec(sel)?.[1]
    return [...String(el("org-edit")?.innerHTML ?? "").matchAll(/<input type="checkbox" name="([^"]+)" value="([^"]+)"([^>]*)>/g)]
      .filter((m) => m[1] === name)
      .map((m) => ({ value: m[2], checked: ticked.get(m[1] + "/" + m[2]) ?? /\bchecked\b/.test(m[3]) }))
  }
  const doc = { getElementById: el, querySelectorAll, addEventListener: (t: string, f: (ev: any) => void) => { (onDoc[t] ??= []).push(f) } }
  const posts: any[] = []
  const reply = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body })
  const fetchStub = (url: string, init: any) => {
    if (url === "/api/admin/pictures") return reply(200, {})
    if (url === "/api/admin/org") {
      return reply(200, { exists: true, live: true, roots: [], outside: [], relations: [], people: [], setup: readOrgSetup(cfg), canEdit: owner, ...(owner ? { choices: orgChoices(cfg) } : {}) })
    }
    if (url === "/api/admin/org/chart" && init?.method === "POST") {
      const body = JSON.parse(init.body)
      posts.push(body)
      if (!owner) return reply(403, { error: "Only the owner can change the org chart." })
      const no = opts.refuse?.(body)
      if (no) return reply(400, { error: no })
      try { return reply(200, { summary: applyOrgEdit(cfg, body) }) } catch (e: any) { return reply(400, { error: e.message }) }
    }
    return reply(404, { error: "not found" })
  }
  new Function("document", "window", "fetch", "location", "setInterval", script)(doc, { addEventListener() {} }, fetchStub, { hash: opts.hash ?? "" }, () => 0)
  const click = (attrs: Record<string, string>) => {
    const t = { getAttribute: (k: string) => attrs[k], disabled: false }
    const ev = { target: { closest: (sel: string) => Object.keys(attrs).some((k) => sel.includes(`[${k}]`)) ? t : null } }
    for (const f of onDoc.click ?? []) f(ev)
  }
  const key = (k: string) => { for (const f of onDoc.keydown ?? []) f({ key: k, preventDefault: () => {} }) }
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  const edit = () => el("org-edit")!.innerHTML as string
  const pick = (from: string, type: string, to: string) => { el("oe-rel-from")!.value = from; el("oe-rel-type")!.value = type; el("oe-rel-to")!.value = to }
  return { el, click, key, settle, edit, pick, posts, cfg, ticked }
}

describe("Edit org on /org (#1420)", () => {
  it("shows the owner an Edit org button that opens the panel", async () => {
    const o = openOrg()
    await o.settle()
    expect(o.el("org-edit-btn").hidden).toBe(false)
    expect(o.el("org-edit").hidden).toBe(true)
    o.click({ "data-org-edit": "" })
    expect(o.el("org-edit").hidden).toBe(false)
    expect(o.el("org-edit-btn").textContent).toBe("Done editing")
    expect(o.edit()).toContain('<optgroup label="Agents"><option value="agent:dev">Dev</option></optgroup><optgroup label="People"><option value="person:sam">Sam Doe</option><option value="person:kim">Kim Roe</option></optgroup>')
    expect(o.edit()).toContain('PM <span class="org-kind">reports to</span> Lead')
    o.click({ "data-org-edit": "" })
    expect(o.el("org-edit").hidden).toBe(true)
  })

  it("opens straight away at /org#edit", async () => {
    const o = openOrg({ hash: "#edit" })
    await o.settle()
    expect(o.el("org-edit").hidden).toBe(false)
  })

  // The server's own 403 for a non-owner POST is in org-edit.test.ts.
  it("gives anyone else the diagram only: no Edit button and no panel, even at /org#edit", async () => {
    const o = openOrg({ owner: false, hash: "#edit" })
    await o.settle()
    expect(o.el("org-edit-btn").hidden).toBe(true)
    expect(o.el("org-edit").hidden).toBe(true)
    expect(o.edit()).toBe("")
    o.click({ "data-org-edit": "" })
    expect(o.el("org-edit").hidden).toBe(true)
    expect(o.edit()).toBe("")
    expect(o.posts).toEqual([])
  })

  it("adds a member and saves a role at once", async () => {
    const o = openOrg({ hash: "#edit" })
    await o.settle()
    o.el("oe-add-member").value = "agent:dev"
    o.el("oe-add-role").value = "Engineer"
    o.click({ "data-oe": "add-member" })
    await o.settle()
    expect(o.posts).toEqual([{ op: "add-member", member: "agent:dev", role: "Engineer" }])
    expect(o.cfg.business.orgChart.dev.role).toBe("eng")
    expect(o.edit()).toContain('<p class="oe-msg" role="status">Dev added to the org chart. Saved.</p>')
    o.el("oe-role-0").value = "Head"
    o.click({ "data-oe": "set-role", "data-oe-i": "0", "data-oe-member": "agent:lead" })
    await o.settle()
    expect(o.posts[1]).toEqual({ op: "set-role", member: "agent:lead", role: "Head" })
  })

  it("offers Add agent here on each member, opening the Hub's new-agent form under them (#1678)", async () => {
    const o = openOrg({ hash: "#edit" })
    await o.settle()
    expect(o.edit()).toContain('<a class="ax-btn" href="/hub#page=settings&amp;section=agents&amp;under=agent%3Apm" aria-label="Add an agent who reports to PM">Add agent here</a>')
  })

  it("shows each agent's working hours and saves new ones with Save hours (#1715)", async () => {
    const o = openOrg({ hash: "#edit" })
    await o.settle()
    expect(o.edit()).toContain('<legend class="org-kind">Working hours of PM</legend>')
    expect(o.edit()).toContain('<input type="time" id="oe-start-1" value="08:00" aria-label="Start time of PM">')
    expect(o.edit()).toContain('<input type="time" id="oe-end-1" value="12:00" aria-label="End time of PM">')
    expect(o.edit()).toContain('<input type="checkbox" name="oe-days-1" value="mon" checked aria-label="Monday">Mon')
    expect(o.edit()).toContain('<input type="checkbox" name="oe-days-1" value="tue" aria-label="Tuesday">Tue')
    o.el("oe-start-1").value = "10:00"
    o.el("oe-end-1").value = "18:00"
    o.ticked.set("oe-days-1/mon", false)
    o.ticked.set("oe-days-1/wed", true)
    o.ticked.set("oe-days-1/thu", true)
    o.click({ "data-oe": "set-schedule", "data-oe-i": "1", "data-oe-member": "agent:pm" })
    await o.settle()
    expect(o.posts).toEqual([{ op: "set-schedule", member: "agent:pm", start: "10:00", end: "18:00", days: ["wed", "thu"] }])
    expect(o.cfg.business.orgChart.pm.schedule).toEqual({ start: "10:00", end: "18:00", days: ["wed", "thu"] })
    expect(o.edit()).toContain("PM works Wednesday and Thursday, 10:00 to 18:00. Saved.")
    expect(o.edit()).toContain('<input type="time" id="oe-start-1" value="10:00"')
  })

  it("gives a person no working hours, and shows a bad time's refusal", async () => {
    const o = openOrg({ hash: "#edit" })
    await o.settle()
    o.el("oe-add-member").value = "person:kim"
    o.click({ "data-oe": "add-member" })
    await o.settle()
    expect(o.edit()).not.toContain("Working hours of Kim Roe")
    o.el("oe-start-0").value = "18:00"
    o.el("oe-end-0").value = "09:00"
    o.click({ "data-oe": "set-schedule", "data-oe-i": "0", "data-oe-member": "agent:lead" })
    await o.settle()
    expect(o.edit()).toContain('<p class="oe-msg is-bad" role="status">The end time (09:00) must be after the start time (18:00).</p>')
    expect(o.cfg.business.orgChart.lead.schedule).toEqual({ days: ["mon"], start: "08:00", end: "12:00" })
  })

  it("adds a first boss only after Save the move", async () => {
    const o = openOrg({ hash: "#edit" })
    await o.settle()
    o.el("oe-add-member").value = "agent:dev"
    o.el("oe-add-role").value = "Engineer"
    o.click({ "data-oe": "add-member" })
    await o.settle()
    o.pick("agent:dev", "reports-to", "agent:pm")
    o.click({ "data-oe": "add-relation" })
    await o.settle()
    expect(o.posts).toHaveLength(1)
    expect(o.edit()).toContain('<p class="oe-confirm-text">Dev will report to PM. When Dev is stuck, it asks PM first.</p>')
    expect(o.edit()).toContain('data-oe="confirm">Save the move</button><button type="button" class="ax-btn" data-oe="cancel">Cancel</button>')
    expect(o.el("oe-confirm-save").focused).toBe(true)
    o.click({ "data-oe": "confirm" })
    await o.settle()
    expect(o.posts[1]).toEqual({ op: "add-relation", from: "agent:dev", type: "reports-to", to: "agent:pm" })
    expect(o.cfg.business.orgChart.dev.reportsTo).toBe("pm")
    expect(o.edit()).not.toContain("oe-confirm")
  })

  it("changes a boss: one line on what changes, then remove and add on Save the move", async () => {
    const o = openOrg({ hash: "#edit" })
    await o.settle()
    o.el("oe-add-member").value = "person:sam"
    o.click({ "data-oe": "add-member" })
    await o.settle()
    o.pick("agent:pm", "reports-to", "person:sam")
    o.click({ "data-oe": "add-relation" })
    await o.settle()
    expect(o.edit()).toContain("PM will report to Sam Doe, not Lead. When PM is stuck, it asks Sam Doe first.")
    o.click({ "data-oe": "confirm" })
    await o.settle()
    expect(o.posts.slice(1)).toEqual([
      { op: "remove-relation", from: "agent:pm", type: "reports-to", to: "agent:lead" },
      { op: "add-relation", from: "agent:pm", type: "reports-to", to: "person:sam" },
    ])
    expect(o.cfg.business.orgChart.pm.reportsTo).toBe("person:sam")
    expect(o.edit()).toContain("PM reports to Sam Doe. Saved.")
  })

  it("removes a line and a member after Save the move", async () => {
    const o = openOrg({ hash: "#edit" })
    await o.settle()
    o.click({ "data-oe": "remove-relation", "data-oe-from": "agent:pm", "data-oe-type": "reports-to", "data-oe-to": "agent:lead" })
    await o.settle()
    expect(o.edit()).toContain("PM will no longer report to Lead. When PM is stuck, it no longer asks Lead.")
    o.click({ "data-oe": "confirm" })
    await o.settle()
    expect(o.cfg.business.orgChart.pm.reportsTo).toBeUndefined()
    o.click({ "data-oe": "remove-member", "data-oe-member": "agent:pm" })
    await o.settle()
    expect(o.edit()).toContain('<p class="oe-confirm-text">PM will leave the org chart.</p>')
    o.click({ "data-oe": "confirm" })
    await o.settle()
    expect(o.cfg.business.orgChart.pm).toBeUndefined()
    expect(o.posts.map((p) => p.op)).toEqual(["remove-relation", "remove-member"])
  })

  it("Cancel and Escape send no POST and leave the config as it was", async () => {
    const o = openOrg({ hash: "#edit" })
    await o.settle()
    const before = JSON.stringify(o.cfg)
    o.pick("agent:lead", "reports-to", "agent:pm")
    o.click({ "data-oe": "add-relation" })
    await o.settle()
    o.click({ "data-oe": "cancel" })
    await o.settle()
    expect(o.edit()).toContain('<p class="oe-msg" role="status">Cancelled. Nothing changed.</p>')
    o.click({ "data-oe": "remove-member", "data-oe-member": "agent:lead" })
    await o.settle()
    expect(o.edit()).toContain("Lead will leave the org chart, with 1 line. PM will report to no one.")
    o.key("Escape")
    await o.settle()
    o.click({ "data-oe": "remove-relation", "data-oe-from": "agent:pm", "data-oe-type": "reports-to", "data-oe-to": "agent:lead" })
    await o.settle()
    o.click({ "data-org-edit": "" })   // closing the panel drops it too
    o.click({ "data-org-edit": "" })
    o.click({ "data-oe": "confirm" })  // a stray Save has nothing to send
    await o.settle()
    expect(o.posts).toEqual([])
    expect(JSON.stringify(o.cfg)).toBe(before)
    expect(o.edit()).not.toContain("oe-confirm")
  })

  it("shows each refusal as the server wrote it, and puts the old boss back when the new one is refused", async () => {
    const o = openOrg({ hash: "#edit" })
    await o.settle()
    // A loop: Lead cannot report to PM, who reports to Lead.
    o.pick("agent:lead", "reports-to", "agent:pm")
    o.click({ "data-oe": "add-relation" })
    await o.settle()
    o.click({ "data-oe": "confirm" })
    await o.settle()
    expect(o.edit()).toContain('<p class="oe-msg is-bad" role="status">Lead cannot report to PM: PM already reports up to Lead.</p>')
    // A move whose new line is refused: the old line comes back.
    o.el("oe-add-member").value = "person:kim"
    o.click({ "data-oe": "add-member" })
    await o.settle()
    const before = structuredClone(o.cfg.business.orgChart)
    const r = openOrg({ hash: "#edit", cfg: o.cfg, refuse: (b) => b.op === "add-relation" && b.to === "person:kim" ? "Kim Roe is away." : null })
    await r.settle()
    r.pick("agent:pm", "reports-to", "person:kim")
    r.click({ "data-oe": "add-relation" })
    await r.settle()
    r.click({ "data-oe": "confirm" })
    await r.settle()
    expect(r.posts.map((p) => p.op + " " + p.to)).toEqual(["remove-relation agent:lead", "add-relation person:kim", "add-relation agent:lead"])
    expect(r.edit()).toContain("Kim Roe is away. Nothing was changed.")
    expect(r.cfg.business.orgChart).toEqual(before)
  })
})

describe("orgConfirmFor", () => {
  const setup = {
    members: [
      { ref: "agent:a", kind: "agent" as const, id: "a", name: "Ana" },
      { ref: "agent:b", kind: "agent" as const, id: "b", name: "Ben" },
      { ref: "person:p", kind: "person" as const, id: "p", name: "Pat" },
    ],
    relations: [{ from: "agent:a", to: "agent:b", type: "reports-to" }, { from: "agent:b", to: "person:p", type: "reports-to" }],
  }
  it("is null for changes that save at once", () => {
    expect(orgConfirmFor(setup, { op: "add-member", member: "agent:c" })).toBeNull()
    expect(orgConfirmFor(setup, { op: "set-role", member: "agent:a", role: "x" })).toBeNull()
  })
  it("gives one confirm line for a dotted line or acts-for", () => {
    expect(orgConfirmFor(setup, { op: "add-relation", from: "agent:a", type: "acts-for", to: "person:p" })!.text).toBe("Ana will act for Pat.")
    expect(orgConfirmFor(setup, { op: "add-relation", from: "agent:a", type: "dotted-line", to: "person:p" })!.text).toBe("Ana will have a dotted line to Pat.")
  })
  it("sends a same-boss or self line as one step, for the server to refuse", () => {
    expect(orgConfirmFor(setup, { op: "add-relation", from: "agent:a", type: "reports-to", to: "agent:b" })!.steps).toHaveLength(1)
    expect(orgConfirmFor(setup, { op: "add-relation", from: "agent:a", type: "reports-to", to: "agent:a" })!.steps).toHaveLength(1)
  })
})
