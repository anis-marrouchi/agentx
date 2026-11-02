import { describe, it, expect } from "vitest"
import { orgWhoDepartments, orgWhoFilter, orgWhoKeeps, orgWhoOf } from "../src/business/org-who"
import { injectFns } from "../src/daemon/ui/inject"
import { buildOrgView } from "../src/business/org-view"
import { ORG_PEOPLE_JS, renderOrgPage } from "../src/daemon/ui/pages/org"
import { WALL_ORG_SCRIPT } from "../src/daemon/ui/pages/wall-org.client"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"

// Who the Org page shows (#1681, item 6): Everyone, People or Agents.

describe("the org who switch", () => {
  it("reads who= from a link, everyone unless people or agents", () => {
    expect(orgWhoOf("people")).toBe("people")
    expect(orgWhoOf("agents")).toBe("agents")
    expect(orgWhoOf("")).toBe("everyone")
    expect(orgWhoOf(null)).toBe("everyone")
    expect(orgWhoOf("bots")).toBe("everyone")
  })

  it("keeps people, agents (remote ones too) or everyone", () => {
    expect(orgWhoKeeps("person:anis", "people")).toBe(true)
    expect(orgWhoKeeps("agent:coo", "people")).toBe(false)
    expect(orgWhoKeeps("agent:clawd/graph", "agents")).toBe(true)
    expect(orgWhoKeeps("person:anis", "agents")).toBe(false)
    expect(orgWhoKeeps("person:anis", "everyone")).toBe(true)
    expect(orgWhoKeeps("agent:coo", "everyone")).toBe(true)
  })

  // anis ← coo ← pm ← nadia ← dev ← sami: people and agents alternate down a deep chain.
  const chain = [
    { key: "person:anis" },
    { key: "agent:coo", boss: "person:anis" },
    { key: "agent:pm", boss: "agent:coo" },
    { key: "person:nadia", boss: "agent:pm" },
    { key: "agent:dev", boss: "person:nadia" },
    { key: "person:sami", boss: "agent:dev" },
  ]

  it("shows everyone as they are", () => {
    expect(orgWhoFilter(chain, "everyone")).toEqual(chain)
  })

  it("moves a person's reports up past every hidden agent boss, however deep", () => {
    expect(orgWhoFilter(chain, "people")).toEqual([
      { key: "person:anis" },
      { key: "person:nadia", boss: "person:anis" },
      { key: "person:sami", boss: "person:nadia" },
    ])
  })

  it("moves an agent's reports up past hidden people, and to the top when no agent is above", () => {
    expect(orgWhoFilter(chain, "agents")).toEqual([
      { key: "agent:coo" },
      { key: "agent:pm", boss: "agent:coo" },
      { key: "agent:dev", boss: "agent:pm" },
    ])
  })

  it("ends the climb on a loop or a boss that is not a member", () => {
    const loop = [
      { key: "person:a", boss: "agent:x" },
      { key: "agent:x", boss: "agent:y" },
      { key: "agent:y", boss: "agent:x" },
      { key: "person:b", boss: "agent:gone" },
    ]
    expect(orgWhoFilter(loop, "people")).toEqual([{ key: "person:a" }, { key: "person:b" }])
  })

  const by = {
    boxes: [
      { id: "eng", name: "Engineering", head: "person:anis", members: ["agent:dev", "agent:qa", "person:nadia"], also: [{ key: "agent:pm", home: "Ops" }] },
      { id: "ops", name: "Ops", head: "agent:coo", members: ["agent:pm"] },
      { id: "fin", name: "Finance", members: [] },
    ],
    rest: ["person:guest-free", "agent:helper"],
  }

  it("turns a hidden head into a text line and counts shown of total", () => {
    const v = orgWhoDepartments(by, "agents")
    expect(v.boxes[0]).toEqual({ id: "eng", name: "Engineering", hiddenHead: "person:anis", members: ["agent:dev", "agent:qa"], also: [{ key: "agent:pm", home: "Ops" }], shown: 2, total: 4 })
    expect(v.boxes[1]).toEqual({ id: "ops", name: "Ops", head: "agent:coo", members: ["agent:pm"], shown: 2, total: 2 })
    expect(v.rest).toEqual(["agent:helper"])
    expect(v.restTotal).toBe(2)
  })

  it("leaves a box with no one shown empty, with no head line when it had no head", () => {
    const v = orgWhoDepartments(by, "people")
    expect(v.boxes[1]).toEqual({ id: "ops", name: "Ops", hiddenHead: "agent:coo", members: [], shown: 0, total: 2 })
    expect(v.boxes[2]).toEqual({ id: "fin", name: "Finance", members: [], shown: 0, total: 0 })
    expect(v.boxes[0].also).toBeUndefined()
    expect(v.boxes[0].head).toBe("person:anis")
  })

  it("keeps the Departments view whole for everyone", () => {
    const v = orgWhoDepartments(by, "everyone")
    expect(v.boxes.map((b) => [b.head, b.members.length, b.shown, b.total])).toEqual([["person:anis", 3, 4, 4], ["agent:coo", 1, 2, 2], [undefined, 0, 0, 0]])
    expect(v.rest).toEqual(by.rest)
  })

  it("runs the same in the browser, injected", () => {
    const fns = new Function(`${injectFns({ orgWhoKeeps, orgWhoFilter, orgWhoDepartments })}; return { orgWhoFilter, orgWhoDepartments }`)()
    expect(fns.orgWhoFilter(chain, "people")).toEqual(orgWhoFilter(chain, "people"))
    expect(fns.orgWhoDepartments(by, "agents")).toEqual(orgWhoDepartments(by, "agents"))
  })
})

// The switch on the pages: /org (org.ts) and the Hub's Org page (wall-org.client.ts).
describe("the who switch on the org pages", () => {
  const config = {
    agents: { coo: { name: "COO" }, pm: { name: "PM" }, dev: { name: "Dev" } },
    people: [{ id: "anis", name: "Anis", role: "owner" }, { id: "nadia", name: "Nadia" }],
    business: {
      orgChart: { coo: { reportsTo: "person:anis" }, pm: { reportsTo: "coo" }, dev: { reportsTo: "person:nadia" } },
      relations: [{ from: "person:nadia", to: "agent:pm", type: "reports-to" as const }],
      departments: { eng: { name: "Engineering", head: "agent:coo", members: ["pm", "person:nadia", "dev"] } },
    },
  }
  const view = buildOrgView(config, {}, null)
  const fns = new Function(`${injectFns({ orgWhoKeeps, orgWhoFilter, orgWhoDepartments })}${ORG_PEOPLE_JS}; return { withPeople, whoTree, deptViewHtml }`)()
  const shape = (list: any[]): any => list.map((n) => [n.name, shape(n.reports || [])])

  it("files the /org tree's people under the nearest shown person", () => {
    const roots = fns.withPeople(view).roots
    expect(shape(fns.whoTree(roots, "everyone"))).toEqual(shape(roots))
    expect(shape(fns.whoTree(roots, "people"))).toEqual([["Anis", [["Nadia", []]]]])
    expect(shape(fns.whoTree(roots, "agents"))).toEqual([["COO", [["PM", [["Dev", []]]]]]])
    // The tree it was given is left as it was.
    expect(shape(roots)).toEqual([["Anis", [["COO", [["PM", [["Nadia", [["Dev", []]]]]]]]]]])
  })

  it("draws /org Departments with a hidden head as a text line and a count", () => {
    const by = orgWhoDepartments(view.byDepartment, "people")
    const html = fns.deptViewHtml(by, (k: string) => `[${k}]`, (s: string) => s, "people", (k: string) => (k === "agent:coo" ? "COO" : k))
    expect(html).toContain('<h2 class="org-dname">Engineering <small>1 of 4</small></h2><p class="org-quiet">Head: COO (agent)</p><div class="org-dgrid">[person:nadia]</div>')
    expect(html).toContain('<h2 class="org-dname">Not in a department <small>1 of 1</small></h2><div class="org-dgrid">[person:anis]</div>')
    const agents = fns.deptViewHtml(orgWhoDepartments(view.byDepartment, "agents"), (k: string) => `[${k}]`, (s: string) => s, "agents", (k: string) => k)
    expect(agents).toContain('Not in a department <small>0 of 1</small></h2><p class="org-quiet">No agents here</p>')
  })

  it("puts Show: Everyone | People | Agents in the /org toolbar, after the views, and keeps it in ?who=", () => {
    const page = renderOrgPage()
    expect(page.indexOf('data-org-who="everyone" aria-pressed="true">Everyone')).toBeGreaterThan(page.indexOf('id="org-views"'))
    expect(page).toContain('data-org-who="people"')
    expect(page).toContain('data-org-who="agents"')
    expect(page).toContain("u.searchParams.delete('who'); else u.searchParams.set('who', who)")
    // The page's script still parses.
    const script = page.match(/<script>\s*(\(function \(\) \{[^]*?)<\/script>/)![1]
    expect(() => new Function(script)).not.toThrow()
  })

  it("puts the switch in the Hub toolbar and who= in its hash, left out for everyone", () => {
    expect(WALL_ORG_SCRIPT).toContain("orgViewsHtml() + orgWhoHtml()")
    expect(WALL_ORG_SCRIPT).toContain("function orgWrite(q) { if (ORG.who !== 'everyone') q.set('who', ORG.who); }")
    expect(WALL_PAGE_SCRIPT).toContain("if (S.page === 'org') orgWrite(q);")
    expect(WALL_PAGE_SCRIPT).toContain("if (S.page === 'org') orgRead(q);")
    expect(() => new Function(WALL_PAGE_SCRIPT)).not.toThrow()
  })
})
