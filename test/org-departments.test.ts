import { describe, it, expect } from "vitest"
import { businessConfigSchema } from "../src/business/config"
import { departmentsProblem, orgDepartments } from "../src/business/departments"
import { layoutOrg } from "../src/business/org-layout"
import { buildOrgView } from "../src/business/org-view"
import { ORG_PEOPLE_JS, renderOrgPage } from "../src/daemon/ui/pages/org"

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

describe("the /org page (#1681)", () => {
  const helpers = new Function(`${ORG_PEOPLE_JS}; return { withPeople: withPeople, byDept: byDept }`)() as {
    withPeople: (d: any) => { roots: any[]; names: Record<string, string> }
    byDept: (list: any[], depts: Record<string, any>) => any[]
  }

  it("has a legend with the person and agent tags", () => {
    const page = renderOrgPage()
    expect(page).toMatch(/<span class="org-tag is-agent"><svg[^]*?<\/svg>Agent<\/span>/)
    expect(page).toMatch(/<span class="org-tag is-person"><svg[^]*?<\/svg>Person<\/span>/)
    expect(page).toContain('<li id="org-legend-dept" hidden>')
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
