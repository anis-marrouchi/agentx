import { describe, it, expect } from "vitest"
import { businessConfigSchema } from "../src/business/config"
import { departmentBoxes, departmentsProblem, orgDepartments } from "../src/business/departments"
import { layoutOrg } from "../src/business/org-layout"
import { applyOrgEdit, readOrgSetup } from "../src/business/org-edit"
import { buildOrgView } from "../src/business/org-view"
import { ORG_PEOPLE_JS, renderOrgPage } from "../src/daemon/ui/pages/org"
import { WALL_ORG_CSS, WALL_ORG_SCRIPT } from "../src/daemon/ui/pages/wall-org.client"

// Departments on the org chart, and people vs agents on sight (#1681).

const config = {
  agents: { pm: { name: "PM" }, ops: { name: "Ops" }, sales: { name: "Sales" } },
  people: [{ id: "anis", name: "Anis", role: "owner" }, { id: "saber", name: "Saber" }],
  business: {
    orgChart: { pm: { reportsTo: "person:anis" }, ops: { reportsTo: "person:anis" }, sales: { reportsTo: "person:anis" } },
    relations: [{ from: "person:saber", to: "person:anis", type: "reports-to" as const }],
    departments: { dev: { name: "Dev", head: "person:anis", members: ["pm", "agent:ops", "person:saber", "pm"] } },
  },
}

describe("business.departments", () => {
  it("is optional in the schema and keeps name, head and members", () => {
    expect(businessConfigSchema.parse({}).departments).toEqual({})
    const parsed = businessConfigSchema.parse({ departments: { dev: { name: "Dev", head: "person:anis" } } })
    expect(parsed.departments.dev).toEqual({ name: "Dev", head: "person:anis", members: [] })
    expect(() => businessConfigSchema.parse({ departments: { dev: { name: "" } } })).toThrow()
  })

  it("writes members and head in full, without repeats, sorted by name", () => {
    expect(orgDepartments({ departments: { z: { name: "Zeta", members: [] }, ...config.business.departments } })).toEqual([
      { id: "dev", name: "Dev", head: "person:anis", members: ["agent:pm", "agent:ops", "person:saber"] },
      { id: "z", name: "Zeta", members: [] },
    ])
    expect(orgDepartments(undefined)).toEqual([])
  })

  it("names an unknown member or head, and a member in two departments", () => {
    const agents = new Set(["pm", "ops"]), people = new Set(["anis"])
    const dept = (members: string[], head?: string) => ({ id: "dev", name: "Dev", members, ...(head ? { head } : {}) })
    expect(departmentsProblem([dept(["agent:pm"], "person:anis")], agents, people)).toBeUndefined()
    expect(departmentsProblem([dept(["agent:qa"])], agents, people)).toBe('Department Dev lists "qa", which is not an agent in business.orgChart')
    expect(departmentsProblem([dept([], "person:kim")], agents, people)).toBe('Department Dev is headed by "kim", which is not a person in people')
    expect(departmentsProblem([dept(["agent:pm"]), { id: "ops", name: "Ops", members: ["agent:pm"] }], agents, people))
      .toBe('"agent:pm" is in both department Dev and Ops; a member is in one department')
  })
})

describe("the org view with departments", () => {
  it("returns the departments and marks each member's card, a person named only there included", () => {
    const view = buildOrgView(config, {}, null)
    expect(view.problem).toBeUndefined()
    expect(view.departments.map((d) => d.id)).toEqual(["dev"])
    const dept = Object.fromEntries(view.diagram.boxes.map((b) => [b.key, b.department]))
    expect(dept).toEqual({ "person:anis": undefined, "agent:ops": "dev", "agent:pm": "dev", "person:saber": "dev", "agent:sales": undefined })
  })

  it("reports a department problem after the relations hold, and the relations problem first", () => {
    const bad = { ...config, business: { ...config.business, departments: { dev: { name: "Dev", members: ["ghost"] } } } }
    expect(buildOrgView(bad, {}, null).problem).toBe('Department Dev lists "ghost", which is not an agent in business.orgChart')
    const both = { ...bad, business: { ...bad.business, relations: [{ from: "pm", to: "person:kim", type: "reports-to" as const }] } }
    expect(buildOrgView(both, {}, null).problem).toMatch(/^Org relation reports-to names "kim"/)
  })

  it("lays a group's siblings side by side, before the ungrouped ones", () => {
    const members = [{ key: "boss", name: "Boss" }, { key: "a", name: "A" }, { key: "b", name: "B", group: "dev" }, { key: "c", name: "C" }, { key: "d", name: "D", group: "dev" }]
    const rel = (from: string) => ({ from, to: "boss", type: "reports-to" as const })
    const lay = layoutOrg(members, ["a", "b", "c", "d"].map(rel))
    expect(lay.boxes.map((b) => b.key)).toEqual(["boss", "b", "d", "a", "c"])
  })
})

describe("department rules (COO, #1681)", () => {
  const agents = new Set(["pm", "ops", "mk"]), people = new Set(["anis", "nadia"])

  it("a: the head need not be a member, and one person may head several departments", () => {
    const depts = orgDepartments({ departments: {
      dev: { name: "Dev", head: "person:anis", members: ["pm", "ops"] },
      mk: { name: "Marketing", head: "person:anis", members: ["mk", "person:nadia"] },
    } })
    expect(departmentsProblem(depts, agents, people)).toBeUndefined()
    // Heading one department and sitting in another is not "in two departments" either.
    const both = orgDepartments({ departments: { dev: { name: "Dev", head: "person:nadia", members: ["pm"] }, mk: { name: "Marketing", members: ["person:nadia"] } } })
    expect(departmentsProblem(both, agents, people)).toBeUndefined()
  })

  it("b: members outside any department, or no departments at all, are not a problem", () => {
    const none = { ...config, business: { ...config.business, departments: undefined } }
    const view = buildOrgView(none, {}, null)
    expect(view.problem).toBeUndefined()
    expect(view.departments).toEqual([])
    expect(view.diagram.boxes.every((b) => b.department === undefined)).toBe(true)
    // In the config above Sales has no department: no problem, no chip.
    const withDev = buildOrgView(config, {}, null)
    expect(withDev.problem).toBeUndefined()
    expect(withDev.diagram.boxes.find((b) => b.key === "agent:sales")?.department).toBeUndefined()
  })

  it("c: a department split over the chart gets one band per run of cards that sit together", () => {
    // P and Q at the top; P has a (dev) and c, Q has d (dev). Row 2 reads a, c, d.
    const members = [{ key: "p", name: "P" }, { key: "q", name: "Q" }, { key: "a", name: "A", group: "dev" }, { key: "c", name: "C" }, { key: "d", name: "D", group: "dev" }]
    const lay = layoutOrg(members, [{ from: "a", to: "p", type: "reports-to" }, { from: "c", to: "p", type: "reports-to" }, { from: "d", to: "q", type: "reports-to" }])
    const band = Object.fromEntries(lay.boxes.map((b) => [b.key, b.band]))
    expect(band.p).toBeUndefined()
    expect(band.c).toBeUndefined()
    expect(band.a).not.toBe(band.d)
    // Side by side with nothing between: one band.
    const one = layoutOrg([{ key: "p", name: "P" }, { key: "a", name: "A", group: "dev" }, { key: "b", name: "B", group: "dev" }, { key: "c", name: "C" }],
      ["a", "b", "c"].map((from) => ({ from, to: "p", type: "reports-to" as const })))
    const b1 = Object.fromEntries(one.boxes.map((b) => [b.key, b.band]))
    expect(b1.a).toBeDefined()
    expect(b1.a).toBe(b1.b)
    expect(b1.c).toBeUndefined()
    // Rows apart (a member and its member boss) are two runs, not one box over both rows.
    const rows = layoutOrg([{ key: "a", name: "A", group: "dev" }, { key: "b", name: "B", group: "dev" }], [{ from: "b", to: "a", type: "reports-to" }])
    const br = Object.fromEntries(rows.boxes.map((b) => [b.key, b.band]))
    expect(br.a).not.toBe(br.b)
  })

  it("d: a department with no head is valid and titled with its name only", () => {
    const depts = orgDepartments({ departments: { dev: { name: "Dev", members: ["pm"] } } })
    expect(depts[0].head).toBeUndefined()
    expect(departmentsProblem(depts, agents, people)).toBeUndefined()
    const title = new Function(`${ORG_PEOPLE_JS}; return deptTitleHtml`)() as (dep: any, nameOf: (k: string) => string, esc: (s: string) => string) => string
    const id = (s: string) => s
    expect(title(depts[0], id, id)).toBe('<span class="org-dept-name">Dev</span>')
    expect(title({ ...depts[0], head: "person:anis" }, () => "Anis", id)).toBe('<span class="org-dept-name">Dev</span><span class="org-dept-head">Head: Anis</span>')
  })
})

describe("the Departments view data (#1681)", () => {
  it("keeps the head out of the member grid and lists everyone no department holds", () => {
    const depts = orgDepartments({ departments: { dev: { name: "Dev", head: "person:anis", members: ["person:anis", "pm"] }, ops: { name: "Ops", members: [] } } })
    expect(departmentBoxes(depts, ["person:anis", "agent:pm", "agent:qa", "agent:qa"])).toEqual({
      boxes: [
        { id: "dev", name: "Dev", head: "person:anis", members: ["agent:pm"] },
        { id: "ops", name: "Ops", members: [] },
      ],
      rest: ["agent:qa"],
    })
  })

  it("is on the org view: people first then agents by name, outside agents last", () => {
    const view = buildOrgView({ ...config, agents: { ...config.agents, loose: { name: "Loose" } } }, {}, null)
    expect(view.byDepartment).toEqual({
      boxes: [{ id: "dev", name: "Dev", head: "person:anis", members: ["agent:pm", "agent:ops", "person:saber"] }],
      rest: ["agent:sales", "agent:loose"],
    })
    expect(buildOrgView({ agents: { a: {} } }, {}, null).byDepartment).toEqual({ boxes: [], rest: ["agent:a"] })
  })
})

describe("the /org page (#1681)", () => {
  const helpers = new Function(`${ORG_PEOPLE_JS}; return { withPeople: withPeople, byDept: byDept, deptViewHtml: deptViewHtml }`)() as {
    withPeople: (d: any) => { roots: any[]; names: Record<string, string>; nodes: Record<string, any> }
    byDept: (list: any[], depts: Record<string, any>) => any[]
    deptViewHtml: (by: any, cardOf: (k: string) => string, esc: (s: string) => string) => string
  }

  it("has a Departments / Chart switch, hidden until there are departments", () => {
    const page = renderOrgPage()
    expect(page).toContain('<div id="org-views" class="org-views" role="group" aria-label="View" hidden><button type="button" data-org-view="dept" aria-pressed="true">Departments</button>')
    expect(page).toContain('<div id="org-depts" class="org-depts" hidden></div>')
  })

  it("draws the Departments view: name, Head then the head's card, member grid, then the rest", () => {
    const view = buildOrgView({ ...config, agents: { ...config.agents, loose: { name: "Loose" } } }, {}, null)
    const html = helpers.deptViewHtml(view.byDepartment, (k) => `[${k}]`, (s) => s)
    expect(html).toBe('<section class="org-dbox" data-dept="dev" aria-label="Dev"><h2 class="org-dname">Dev</h2>'
      + '<div class="org-dhead"><span class="org-lead">Head</span>[person:anis]</div>'
      + '<div class="org-dgrid">[agent:pm][agent:ops][person:saber]</div></section>'
      + '<section class="org-dbox is-rest" aria-label="Not in a department"><h2 class="org-dname">Not in a department</h2>'
      + '<div class="org-dgrid">[agent:sales][agent:loose]</div></section>')
    // Every key it asks for has a node to draw, outside agents aside.
    const nodes = helpers.withPeople(view).nodes
    for (const k of ["person:anis", "agent:pm", "agent:ops", "person:saber", "agent:sales"]) expect(nodes[k]).toBeTruthy()
  })

  it("has a legend with the person and agent tags", () => {
    const page = renderOrgPage()
    expect(page).toMatch(/<span class="org-tag is-agent"><svg[^]*?<\/svg>Agent<\/span>/)
    expect(page).toMatch(/<span class="org-tag is-person"><svg[^]*?<\/svg>Person<\/span>/)
    expect(page).toContain('<li id="org-legend-dept" hidden>')
  })

  it("puts the view switch in a toolbar row above the legend", () => {
    const page = renderOrgPage()
    const bar = page.indexOf('<div class="org-toolbar" role="toolbar" aria-label="Org tools">')
    expect(bar).toBeGreaterThan(-1)
    expect(page.indexOf('id="org-views"')).toBeGreaterThan(bar)
    expect(page.indexOf('<ul class="org-legend"')).toBeGreaterThan(page.indexOf('id="org-views"'))
  })

  it("fits the Hub chart to the pane on first paint, floor 60%, and keeps a reader's zoom", () => {
    // Called from orgDraw() after the size is set, desktop only; a changed zoom paints again.
    expect(WALL_ORG_SCRIPT).toMatch(/if \(phone\) return;\s*if \(orgFit\(chart\)\) return;/)
    expect(WALL_ORG_SCRIPT).toContain("var ORG_FIT_FLOOR = 0.6;")
    const fn = WALL_ORG_SCRIPT.slice(WALL_ORG_SCRIPT.indexOf("function orgFit("), WALL_ORG_SCRIPT.indexOf("function orgShowStart("))
    expect(fn).toContain("if (ORG.fitted || !scroll) return false;")
    expect(fn).toContain("Math.max(ORG_FIT_FLOOR, Math.min(1, Math.floor(room / w * 100) / 100))")
    // A reader's zoom is never refitted.
    const zoom = WALL_ORG_SCRIPT.slice(WALL_ORG_SCRIPT.indexOf("function orgZoom("), WALL_ORG_SCRIPT.indexOf("document.addEventListener('click'", WALL_ORG_SCRIPT.indexOf("function orgZoom(")))
    expect(zoom).toContain("ORG.fitted = true;")
    // Still too wide: start at the widest band's left edge, never centred on the head, with an edge fade.
    const start = WALL_ORG_SCRIPT.slice(WALL_ORG_SCRIPT.indexOf("function orgShowStart("), WALL_ORG_SCRIPT.indexOf("function orgEdges("))
    expect(start).toContain("scroll.scrollLeft = widest ? Math.max(0, widest.l * ORG.zoom) : 0;")
    expect(WALL_ORG_SCRIPT).not.toContain("orgShowHead")
    expect(WALL_ORG_CSS).toContain(".wog__scroll.is-more-left { --wog-fade-l: 40px; }")
    expect(WALL_ORG_CSS).toContain(".wog__scroll.is-more-right { --wog-fade-r: 40px; }")
  })

  it("fits a wide /org chart to the page, floor 60%, with a 100% control, and names who is off screen", () => {
    const page = renderOrgPage()
    // The chart takes the window width, and a department band has the same 14px inner padding as the Departments view.
    expect(page).toContain(".org-tree { overflow-x: auto; padding: 12px 0 8px; width: calc(100vw - 48px); margin-left: calc(50% - 50vw + 24px);")
    expect(page).toContain(".org-tree li.org-dept > .org-dept-box { padding: 10px 14px 4px;")
    // Zoom control in the toolbar, with a way back to 100%.
    expect(page).toMatch(/<div id="org-zoom" class="org-views org-zoom" role="group" aria-label="Zoom" hidden>.*data-org-zoom="-1".*id="org-zoom-at" data-org-zoom="0" title="Back to 100%">100%<.*data-org-zoom="1"/)
    const fit = page.slice(page.indexOf("function fit("), page.indexOf("function setZoom("))
    expect(fit).toContain("Math.max(FIT_FLOOR, Math.min(1, Math.floor(room / w * 100) / 100))")
    expect(page).toContain("var zoom = 1, fitted = false, FIT_FLOOR = 0.6;")
    // First paint: fit, then the widest department box's left edge, never the head centred.
    expect(page).toMatch(/if \(!deptView\) \{ fit\(\); showStart\(\); \}\s*zoomLabel\(\);\s*moreCue\(\);/)
    const start = page.slice(page.indexOf("function showStart("), page.indexOf("function moreSide("))
    expect(start).toContain("tree.querySelectorAll('.org-dept-box')")
    expect(start).not.toContain("box.width / 2")
    expect(page).not.toContain("showHead")
    // The cue: one button per side naming the reports cut off there, kept current on scroll.
    expect(page).toMatch(/<div id="org-more" class="org-more" hidden><button type="button" data-org-scroll="-1"[^>]*><\/button><span>The chart is wider than the page\. Scroll sideways to see everyone\.<\/span><button type="button" data-org-scroll="1"/)
    expect(page).toContain("tree.addEventListener('scroll', moreCue, { passive: true });")
  })

  it("gives a person's card a warm fill and keeps an agent's plain, on /org and the Hub", () => {
    const page = renderOrgPage()
    expect(page).toContain(".org-card.is-person { background: var(--org-person-bg); border-color: var(--org-person-ink);")
    expect(page).toMatch(/\.org \{ --org-person-bg: color-mix\(in oklch, #f08c3c 16%, var\(--ax-bg\)\)/)
    expect(WALL_ORG_CSS).toContain(".wog__card.is-person { background: var(--wog-person-bg); border-color: var(--wog-person-ink);")
    expect(WALL_ORG_CSS).toMatch(/\.ax-wall__org, \.ax-wall__orgrail \{ --wog-person-bg: color-mix/)
    expect(WALL_ORG_CSS).toContain(".wog__key.is-person { background: var(--wog-person-bg);")
    // The agent card's own fill stays the page ground.
    expect(WALL_ORG_CSS).toMatch(/\.wog__card \{[^}]*background: var\(--ax-bg\)/)
  })

  it("gives department members a card and their department, and groups them where the first stood", () => {
    const view = buildOrgView(config, {}, null)
    const out = helpers.withPeople(view)
    const anis = out.roots.find((n) => n.id === "anis")
    expect(anis.reports.map((n: any) => [n.id, n.department])).toEqual([["ops", "dev"], ["pm", "dev"], ["sales", undefined], ["saber", "dev"]])
    const depts = { dev: view.departments[0] }
    const drawn = helpers.byDept(anis.reports, depts)
    expect(drawn.map((x: any) => x.dept ? `dept:${x.items.map((n: any) => n.id).join("+")}` : x.id)).toEqual(["dept:ops+pm+saber", "sales"])
  })
})

// Only personnel get a card (Anis 11-01): a client or guest is a line on the
// card a relation joins them to, and may not head or join a department.
describe("clients and guests on the org chart", () => {
  const withGuest = {
    agents: { pm: { name: "PM" }, accountant: { name: "Accountant" } },
    people: [{ id: "anis", name: "Anis", role: "owner" }, { id: "zahra", name: "Zahra", role: "guest" }, { id: "acme", name: "Acme", role: "client" }],
    business: {
      orgChart: { pm: { reportsTo: "person:anis" }, accountant: { reportsTo: "person:anis" } },
      orgPeople: { acme: {} },
      relations: [
        { from: "agent:accountant", to: "person:zahra", type: "dotted-line" as const },
        { from: "person:acme", to: "agent:pm", type: "reports-to" as const },
      ],
    },
  }

  it("gives a guest or client no card, not even placed, and puts 'works with' on the other card", () => {
    const view = buildOrgView(withGuest, {}, null)
    expect(view.problem).toBeUndefined()
    expect(view.diagram.boxes.map((b) => b.key).sort()).toEqual(["agent:accountant", "agent:pm", "person:anis"])
    expect(view.diagram.edges.some((e) => e.to === "person:zahra" || e.from === "person:acme")).toBe(false)
    const box = (key: string) => view.diagram.boxes.find((b) => b.key === key)!
    expect(box("agent:accountant").worksWith).toEqual([{ key: "person:zahra", name: "Zahra", role: "guest" }])
    expect(box("agent:pm").worksWith).toEqual([{ key: "person:acme", name: "Acme", role: "client" }])
    expect(view.people.find((p) => p.id === "zahra")?.outsider).toBe("guest")
    expect(view.byDepartment.rest).not.toContain("person:zahra")
  })

  it("does the same on the /org page", () => {
    const withPeople = new Function(`${ORG_PEOPLE_JS}; return withPeople`)() as (d: any) => { nodes: Record<string, any> }
    const nodes = withPeople(buildOrgView(withGuest, {}, null)).nodes
    expect(Object.keys(nodes).filter((k) => k.startsWith("person:"))).toEqual(["person:anis"])
    expect(nodes["agent:accountant"].worksWith).toEqual(["Zahra (guest)"])
    expect(nodes["agent:accountant"].dottedLine).toBeUndefined()
    expect(nodes["agent:pm"].worksWith).toEqual(["Acme (client)"])
  })

  it("refuses a guest as head or a client as member with a clear sentence, and the daemon view still builds", () => {
    const headed = { ...withGuest, business: { ...withGuest.business, departments: { eng: { name: "Engineering", head: "person:zahra", members: ["pm"] } } } }
    expect(buildOrgView(headed, {}, null).problem)
      .toBe("Department Engineering cannot be headed by Zahra: Zahra is a guest, and only owners and members of the organisation can be in a department")
    const listed = { ...withGuest, business: { ...withGuest.business, departments: { eng: { name: "Engineering", head: "person:anis", members: ["pm", "person:acme"] } } } }
    const view = buildOrgView(listed, {}, null)
    expect(view.problem).toBe("Department Engineering cannot list Acme: Acme is a client, and only owners and members of the organisation can be in a department")
    expect(view.diagram.boxes.some((b) => b.key === "person:acme")).toBe(false)
  })

  it("keeps a person with no role, or a member, as personnel", () => {
    const people = new Set(["saber"])
    const dept = { id: "eng", name: "Engineering", head: "person:saber", members: [] }
    expect(departmentsProblem([dept], new Set(), people, new Set(), new Map())).toBeUndefined()
    const view = buildOrgView({ ...config, people: [{ id: "anis", name: "Anis", role: "owner" }, { id: "saber", name: "Saber", role: "member" }] }, {}, null)
    expect(view.diagram.boxes.some((b) => b.key === "person:saber")).toBe(true)
  })
})

describe("Edit org keeps departments whole (#1681)", () => {
  const fresh = () => structuredClone(config) as any

  it("lists a person named only in a department as a chart member", () => {
    const cfg = fresh()
    cfg.business.relations = []
    expect(readOrgSetup(cfg).members.map((m) => m.ref)).toContain("person:saber")
  })

  it("takes a removed member out of every department, as head too, and the view stays clean", () => {
    const cfg = fresh()
    expect(applyOrgEdit(cfg, { op: "remove-member", member: "agent:pm" })).toBe("PM removed from the org chart, with 1 line and out of Dev")
    expect(cfg.business.departments.dev.members).toEqual(["agent:ops", "person:saber"])
    expect(buildOrgView(cfg, {}, null).problem).toBeUndefined()
    expect(applyOrgEdit(cfg, { op: "remove-member", member: "person:anis" })).toContain("and out of Dev")
    expect(cfg.business.departments.dev.head).toBeUndefined()
  })

  it("still saves an unrelated edit when a department already has a problem", () => {
    const cfg = fresh()
    cfg.people.push({ id: "zahra", name: "Zahra", role: "guest" })
    cfg.business.departments.dev.members.push("person:zahra")
    expect(() => applyOrgEdit(cfg, { op: "set-role", member: "agent:sales", role: "Seller" })).not.toThrow()
  })
})
