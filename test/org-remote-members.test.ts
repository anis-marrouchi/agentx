import { describe, it, expect } from "vitest"
import { businessConfigSchema } from "../src/business/config"
import { chartStaleRefs, departmentsProblem, orgDepartments } from "../src/business/departments"
import { applyOrgEdit } from "../src/business/org-edit"
import { buildOrgView } from "../src/business/org-view"
import { Organization } from "../src/business/organization"
import { configRelationsProblem, configStaleRefs, memberKey, orgRelations, relationsProblem, remoteAgent } from "../src/business/relations"
import { ORG_PEOPLE_JS } from "../src/daemon/ui/pages/org"

// Agents on other mesh nodes in the org chart: `agent:<node>/<id>`, checked
// against mesh.peers only (no network at start), shown but never routed to.

const config = {
  agents: { pm: { name: "PM" }, ops: { name: "Ops" } },
  people: [{ id: "anis", name: "Anis", role: "owner" }],
  mesh: { peers: [{ name: "clawd" }] },
  business: {
    orgChart: { pm: { reportsTo: "person:anis" }, ops: { reportsTo: "agent:clawd/lead" } },
    relations: [
      { from: "agent:clawd/lead", to: "person:anis", type: "reports-to" as const },
      { from: "agent:clawd/seif", to: "agent:pm", type: "dotted-line" as const },
    ],
    departments: { eng: { name: "Engineering", head: "person:anis", members: ["pm", "agent:clawd/seif"] } },
  },
}
const MESH = [{ peer: "clawd", healthy: true, skills: [{ id: "lead", name: "Lead" }, { id: "seif", name: "Seif Agent" }, { id: "omar", name: "Omar" }] }]

describe("agent:<node>/<id> refs", () => {
  it("parses only the two-part form as an agent on another node", () => {
    expect(remoteAgent("agent:clawd/seif")).toEqual({ node: "clawd", id: "seif" })
    // A bare node/id is the same ref written short, as for any agent.
    expect(remoteAgent("clawd/seif")).toEqual({ node: "clawd", id: "seif" })
    expect(memberKey("clawd/seif")).toBe("agent:clawd/seif")
    expect(remoteAgent("agent:seif")).toBeUndefined()
    expect(remoteAgent("person:clawd/seif")).toBeUndefined()
    expect(remoteAgent("agent:a/b/c")).toBeUndefined()
  })

  it("is checked against mesh.peers only: a known peer passes, an unknown one is named", () => {
    const agents = new Set(["pm"]), people = new Set(["anis"])
    const rel = (from: string, to: string) => [{ from, to, type: "reports-to" as const }]
    expect(relationsProblem(rel("agent:pm", "agent:clawd/lead"), agents, people, new Set(["clawd"]))).toBeUndefined()
    // The agent need not be known yet: whether the peer hosts it is a live question for the view.
    expect(relationsProblem(rel("agent:pm", "agent:clawd/nobody"), agents, people, new Set(["clawd"]))).toBeUndefined()
    expect(relationsProblem(rel("agent:pm", "agent:far/lead"), agents, people, new Set(["clawd"])))
      .toBe('Org relation reports-to names "far/lead", but "far" is not a peer in mesh.peers')
    expect(relationsProblem(rel("agent:pm", "agent:a/b/c"), agents, people, new Set(["a"])))
      .toBe('Org relation reports-to names "a/b/c"; an agent on another node is written agent:<node>/<id>')
    // Without peers (the old callers), a remote ref is refused.
    expect(relationsProblem(rel("agent:pm", "agent:clawd/lead"), agents, people)).toMatch(/not a peer in mesh.peers/)
  })

  it("lets a remote agent act for a person, and checks departments the same way", () => {
    const agents = new Set(["pm"]), people = new Set(["anis"]), peers = new Set(["clawd"])
    expect(relationsProblem([{ from: "agent:clawd/seif", to: "person:anis", type: "acts-for" }], agents, people, peers)).toBeUndefined()
    const depts = orgDepartments(config.business)
    expect(departmentsProblem(depts, agents, people, peers)).toBeUndefined()
    expect(departmentsProblem(depts, agents, people, new Set())).toBe('Department Engineering lists "clawd/seif", but "clawd" is not a peer in mesh.peers')
    // A guest is still refused (here as head) when peers are given too.
    const withGuest = [{ ...depts[0], members: [...depts[0].members, "person:anis"] }]
    expect(departmentsProblem(withGuest, agents, people, peers, new Map([["anis", { name: "Anis", role: "guest" as const }]])))
      .toMatch(/Anis is a guest, and only owners and members/)
  })

  it("is read from mesh.peers by the writers' whole-config check", () => {
    expect(configRelationsProblem(config)).toBeUndefined()
    expect(configRelationsProblem({ ...config, mesh: { peers: [] } })).toMatch(/"clawd" is not a peer/)
  })

  it("lets a write keep refs to a peer that has left, and still refuses a new one", () => {
    const gone = { ...config, mesh: { peers: [] } }
    const stale = configStaleRefs(gone)
    expect([...stale].sort()).toEqual(["agent:clawd/lead", "agent:clawd/seif"])
    expect(configRelationsProblem(gone, stale)).toBeUndefined()
    const added = { ...gone, business: { ...gone.business, relations: [...gone.business.relations, { from: "agent:pm", to: "agent:far/x", type: "dotted-line" as const }] } }
    expect(configRelationsProblem(added, stale)).toBe('Org relation dotted-line names "far/x", but "far" is not a peer in mesh.peers')
    // Departments count too, for the chart's own check.
    expect(chartStaleRefs(gone).has("agent:clawd/seif")).toBe(true)
  })
})

describe("Organization with agents on other nodes", () => {
  const schedule = { start: "09:00", end: "17:00" }
  const business = businessConfigSchema.parse({
    roles: { r: { title: "R" } },
    orgChart: { pm: { role: "r", reportsTo: "person:anis", schedule }, ops: { role: "r", reportsTo: "agent:clawd/lead", schedule } },
    relations: config.business.relations,
  })
  const people = [{ id: "anis", name: "Anis" }]

  it("starts with a known peer and no network call, with no warning", () => {
    expect(new Organization(business, people, ["clawd"]).warnings).toEqual([])
  })

  it("still starts when a peer the chart names was removed or renamed, with a warning per ref", () => {
    let org: Organization | undefined
    expect(() => { org = new Organization(business, people, ["clawd-renamed"]) }).not.toThrow()
    expect(org!.warnings).toEqual([
      'Org chart names "clawd/lead", but "clawd" is no longer a peer in mesh.peers; its card shows as unknown until the peer is back or the ref is removed',
      'Org chart names "clawd/seif", but "clawd" is no longer a peer in mesh.peers; its card shows as unknown until the peer is back or the ref is removed',
    ])
    // The ref is kept, and escalation still stops before it.
    expect(org!.reportsTo("ops")).toBe("agent:clawd/lead")
    expect(org!.chainOfCommand("ops")).toEqual(["ops"])
    // Other problems still refuse the start.
    const bad = businessConfigSchema.parse({ ...business, relations: [...config.business.relations, { from: "agent:pm", to: "person:nobody", type: "dotted-line" }] })
    expect(() => new Organization(bad, people, [])).toThrow(/"nobody", which is not a person in people/)
  })

  it("stops escalation at a remote boss: shown, not routed", () => {
    const org = new Organization(business, people, ["clawd"])
    expect(org.reportsTo("ops")).toBe("agent:clawd/lead")
    expect(org.chainOfCommand("ops")).toEqual(["ops"])
    expect(org.escalationChain("ops")).toEqual([])
    // Not counted as staff here, and never a handler.
    expect(org.all().map((e) => e.agentId).sort()).toEqual(["ops", "pm"])
    expect(org.canHandle("clawd/lead", null, null)).toBe(false)
    expect(org.directReports("agent:clawd/lead")).toEqual(["ops"])
  })

  it("takes a reload that drops the peer, with the warnings, and keeps the old chart on a real problem", () => {
    const org = new Organization(business, people, ["clawd"])
    expect(() => org.replaceWith(business, people, [])).not.toThrow()
    expect(org.warnings).toHaveLength(2)
    expect(org.reportsTo("ops")).toBe("agent:clawd/lead")
    org.replaceWith(business, people, ["clawd"])
    expect(org.warnings).toEqual([])
    expect(() => org.replaceWith(business, [], ["clawd"])).toThrow(/not a person in people/)
    expect(org.reportsTo("pm")).toBe("person:anis")
  })
})

describe("The org view with agents on other nodes", () => {
  it("draws a card for each remote agent a relation or department names, with how its node answered", () => {
    const view = buildOrgView(config, {}, null, MESH)
    expect(view.problem).toBeUndefined()
    const box = (key: string) => view.diagram.boxes.find((b) => b.key === key)
    expect(box("agent:clawd/lead")).toMatchObject({ kind: "agent", id: "clawd/lead", name: "Lead", remote: { node: "clawd", agent: "lead", seen: "up" } })
    expect(box("agent:clawd/seif")).toMatchObject({ name: "Seif Agent", department: "eng", remote: { seen: "up" } })
    expect(box("agent:clawd/lead")?.status).toBeUndefined()
    // Local agents keep no remote field.
    expect(box("agent:pm")?.remote).toBeUndefined()
    // The local agent sits under its remote boss on the chart.
    expect(box("agent:ops")?.parent).toBe("agent:clawd/lead")
    expect(view.roots.find((n) => n.id === "ops")?.reportsTo).toBe("agent:clawd/lead")
    expect(view.byDepartment.boxes[0].members).toEqual(["agent:pm", "agent:clawd/seif"])
  })

  it("greys a card when the node is down (last list kept) or never listed it, or the daemon gave no peer list", () => {
    const down = buildOrgView(config, {}, null, [{ ...MESH[0], healthy: false }])
    expect(down.diagram.boxes.find((b) => b.key === "agent:clawd/seif")?.remote?.seen).toBe("down")
    const unseen = buildOrgView(config, {}, null, [{ peer: "clawd", healthy: true, skills: [] }])
    expect(unseen.diagram.boxes.find((b) => b.key === "agent:clawd/seif")).toMatchObject({ name: "seif", remote: { seen: "unseen" } })
    const none = buildOrgView(config, {}, null, null)
    expect(none.mesh.live).toBe(false)
    expect(none.diagram.boxes.filter((b) => b.remote).every((b) => b.remote!.seen === "unseen")).toBe(true)
  })

  it("lists every agent a peer hosts that the chart does not place", () => {
    const view = buildOrgView(config, {}, null, MESH)
    expect(view.mesh).toEqual({ live: true, others: [{ node: "clawd", id: "omar", name: "Omar", healthy: true }] })
  })

  it("keeps the card of a ref to a node no longer in mesh.peers, shown as unknown with a warning, not a problem", () => {
    const view = buildOrgView({ ...config, mesh: { peers: [] } }, {}, null, MESH)
    expect(view.problem).toBeUndefined()
    expect(view.warnings).toHaveLength(2)
    expect(view.warnings![0]).toMatch(/"clawd" is no longer a peer in mesh.peers/)
    // Even though /mesh still lists the agent, the node is not a peer here.
    expect(view.diagram.boxes.find((b) => b.key === "agent:clawd/lead")).toMatchObject({ remote: { node: "clawd", seen: "unknown" } })
    expect(view.diagram.boxes.find((b) => b.key === "agent:ops")?.parent).toBe("agent:clawd/lead")
    expect(buildOrgView(config, {}, null, MESH).warnings).toBeUndefined()
  })

  it("lets the owner edit the chart while a departed peer is named, and refuses a new ref to it", () => {
    const cfg = structuredClone({ ...config, mesh: { peers: [] }, business: { ...config.business, roles: { r: { title: "R" } } } })
    ;(cfg.business.orgChart as any).pm.role = "r"
    ;(cfg.business.orgChart as any).ops.role = "r"
    expect(applyOrgEdit(cfg, { op: "set-role", member: "agent:pm", role: "Lead PM" })).toMatch(/pm is now Lead PM/i)
    // A new ref to the departed node is still refused (the writers' check is above).
    expect(() => applyOrgEdit(cfg, { op: "add-relation", from: "agent:pm", type: "dotted-line", to: "agent:clawd/omar" })).toThrow()
    expect((cfg.business.relations as any[]).some((r) => r.to === "agent:clawd/omar")).toBe(false)
  })

  it("keeps the relations of a remote ref in full", () => {
    expect(orgRelations(config.business)).toContainEqual({ from: "agent:ops", to: "agent:clawd/lead", type: "reports-to" })
  })
})

describe("The /org page with agents on other nodes", () => {
  const h = new Function(`${ORG_PEOPLE_JS}; return { withPeople: withPeople, remoteCardHtml: remoteCardHtml, meshOthersHtml: meshOthersHtml }`)() as {
    withPeople: (d: any) => { roots: any[]; nodes: Record<string, any> }
    remoteCardHtml: (n: any, tag: string, links: string, esc: (s: string) => string) => string
    meshOthersHtml: (others: any[], esc: (s: string) => string) => string
  }
  const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

  it("puts remote cards in the tree: under the person they report to, with local reports under them", () => {
    const org = h.withPeople(buildOrgView(config, {}, null, MESH))
    const anis = org.roots.find((n) => n.id === "anis")
    const lead = anis.reports.find((n: any) => n.id === "clawd/lead")
    expect(lead.remote.node).toBe("clawd")
    expect(lead.reports.map((n: any) => n.id)).toEqual(["ops"])
    expect(org.roots.some((n) => n.id === "ops")).toBe(false)
  })

  it("draws a remote card with its node, grey when down, with no Pause or Activity", () => {
    const up = h.remoteCardHtml({ id: "clawd/seif", name: "Seif", remote: { node: "clawd", agent: "seif", seen: "up" } }, "<tag>", "", esc)
    expect(up).toContain('class="org-card is-remote"')
    expect(up).toContain("seif @ clawd")
    expect(up).toContain(">On clawd</span>")
    expect(up).not.toMatch(/data-hold|Activity/)
    const down = h.remoteCardHtml({ id: "clawd/seif", name: "Seif", remote: { node: "clawd", agent: "seif", seen: "down" } }, "", "", esc)
    expect(down).toContain("is-remote is-gone")
    expect(down).toContain("clawd does not answer; last seen there")
    const unknown = h.remoteCardHtml({ id: "clawd/seif", name: "Seif", remote: { node: "clawd", agent: "seif", seen: "unknown" } }, "", "", esc)
    expect(unknown).toContain("is-remote is-gone")
    expect(unknown).toContain("clawd is no longer a peer of this node")
  })

  it("lists unplaced agents by node with the ref to place them", () => {
    const html = h.meshOthersHtml([{ node: "clawd", id: "omar", name: "Omar", healthy: false }], esc)
    expect(html).toContain("<b>clawd</b>")
    expect(html).toContain("(does not answer)")
    expect(html).toContain("<code>agent:clawd/omar</code>")
  })
})
