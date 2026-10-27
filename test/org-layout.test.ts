import { describe, it, expect } from "vitest"
import { layoutOrg } from "../src/business/org-layout"
import { buildOrgView } from "../src/business/org-view"
import type { OrgRelation } from "../src/business/relations"

// The Org diagram's layout (#1419): levels, columns and lines per type.

const m = (key: string, name = key.split(":")[1]) => ({ key, name })
const at = (l: ReturnType<typeof layoutOrg>) => Object.fromEntries(l.boxes.map((b) => [b.key, [b.level, b.col]]))

describe("the org diagram layout", () => {
  const members = [m("person:owner", "Owner"), m("agent:lead", "Lead"), m("agent:pm", "PM"), m("agent:dev", "Dev"), m("agent:qa", "QA"), m("agent:helper", "Helper")]
  const relations: OrgRelation[] = [
    { from: "agent:lead", to: "person:owner", type: "reports-to" },
    { from: "agent:pm", to: "agent:lead", type: "reports-to" },
    { from: "agent:dev", to: "agent:pm", type: "reports-to" },
    { from: "agent:qa", to: "agent:pm", type: "reports-to" },
    { from: "agent:helper", to: "person:owner", type: "reports-to" },
    { from: "agent:qa", to: "agent:lead", type: "dotted-line" },
    { from: "agent:helper", to: "person:owner", type: "acts-for" },
  ]

  it("puts whoever reports to no one on top and each report one row under its boss", () => {
    const l = layoutOrg(members, relations)
    expect(l.levels).toBe(4)
    expect(Object.fromEntries(l.boxes.map((b) => [b.key, b.level]))).toEqual({
      "person:owner": 0, "agent:helper": 1, "agent:lead": 1, "agent:pm": 2, "agent:dev": 3, "agent:qa": 3,
    })
  })

  it("puts siblings side by side, by name, each under its own boss", () => {
    const l = layoutOrg(members, relations)
    const row = (n: number) => l.boxes.filter((b) => b.level === n).sort((a, b) => a.col - b.col).map((b) => b.key)
    expect(row(1)).toEqual(["agent:helper", "agent:lead"])
    expect(row(3)).toEqual(["agent:dev", "agent:qa"])
    expect(Object.fromEntries(l.boxes.map((b) => [b.key, b.parent]))).toEqual({
      "person:owner": undefined, "agent:helper": "person:owner", "agent:lead": "person:owner", "agent:pm": "agent:lead", "agent:dev": "agent:pm", "agent:qa": "agent:pm",
    })
  })

  it("centres a boss over its reports and never puts two boxes in one cell", () => {
    const l = layoutOrg(members, relations)
    // Leaves by name: Helper (slot 0), Dev (1), QA (2). Half-columns from 1, two per box.
    expect(l.columns).toBe(6)
    expect(at(l)).toEqual({
      "person:owner": [0, 3], "agent:helper": [1, 1], "agent:lead": [1, 4], "agent:pm": [2, 4], "agent:dev": [3, 3], "agent:qa": [3, 5],
    })
    const cells = new Set<string>()
    for (const b of l.boxes) for (const c of [b.col, b.col + 1]) {
      const cell = `${b.level}/${c}`
      expect(cells.has(cell)).toBe(false)
      cells.add(cell)
    }
  })

  it("keeps every relation type as its own line", () => {
    const l = layoutOrg(members, relations)
    const by = (t: string) => l.edges.filter((e) => e.type === t).map((e) => `${e.from}>${e.to}`)
    expect(by("reports-to")).toHaveLength(5)
    expect(by("dotted-line")).toEqual(["agent:qa>agent:lead"])
    expect(by("acts-for")).toEqual(["agent:helper>person:owner"])
  })

  it("does not let a dotted line or acts-for move a box", () => {
    const tree = relations.filter((r) => r.type === "reports-to")
    expect(at(layoutOrg(members, relations))).toEqual(at(layoutOrg(members, tree)))
  })

  it("puts both ends of a loop on top, keeps one boss each, and drops lines to unknown members", () => {
    const l = layoutOrg([m("agent:a"), m("agent:b"), m("agent:c")], [
      { from: "agent:a", to: "agent:b", type: "reports-to" },
      { from: "agent:b", to: "agent:a", type: "reports-to" },
      { from: "agent:c", to: "agent:a", type: "reports-to" },
      { from: "agent:c", to: "agent:b", type: "reports-to" },
      { from: "agent:c", to: "person:gone", type: "acts-for" },
      { from: "agent:c", to: "agent:c", type: "dotted-line" },
      { from: "agent:b", to: "agent:c", type: "dotted-line" },
      { from: "agent:b", to: "agent:c", type: "dotted-line" },
    ])
    expect(l.boxes.filter((b) => b.level === 0).map((b) => b.key)).toEqual(["agent:a", "agent:b"])
    expect(l.edges.map((e) => `${e.type} ${e.from}>${e.to}`)).toEqual(["reports-to agent:c>agent:a", "dotted-line agent:b>agent:c"])
  })

  it("is empty without members", () => {
    expect(layoutOrg([], [])).toEqual({ boxes: [], edges: [], columns: 0, levels: 0 })
  })
})

describe("the org view's diagram", () => {
  const holds = { pm: { kind: "paused" as const, at: "t", by: "the owner" } }
  const live = [{ id: "ceo", active: 1 }, { id: "pm", active: 0 }]

  it("draws the chart's agents with their status, and each reportsTo as a reports-to line", () => {
    const view = buildOrgView({
      agents: { ceo: { name: "Chief" }, pm: { name: "PM" }, solo: { name: "Solo" } },
      business: { orgChart: { ceo: { role: "Boss" }, pm: { role: "Planner", reportsTo: "ceo" } } },
    }, holds, live)
    expect(view.diagram.boxes).toEqual([
      { key: "agent:ceo", kind: "agent", id: "ceo", name: "Chief", title: "Boss", status: "working", active: 1, level: 0, col: 1 },
      { key: "agent:pm", kind: "agent", id: "pm", name: "PM", title: "Planner", status: "paused", active: 0, heldBy: "the owner", level: 1, parent: "agent:ceo", col: 1 },
    ])
    expect(view.diagram.edges).toEqual([{ from: "agent:pm", to: "agent:ceo", type: "reports-to" }])
    expect(view.outside.map((n) => n.id)).toEqual(["solo"])
  })

  it("puts a person boss on top, keeps dotted lines, and keeps acts-for for a person with no card", () => {
    const view = buildOrgView({
      agents: { ceo: { name: "Chief" }, pm: { name: "PM" } },
      people: [{ id: "sam", name: "Sam", role: "owner" }, { id: "alex", name: "Alex", role: "client" }, { id: "kim", name: "Kim" }],
      business: {
        orgChart: { ceo: { role: "Boss", reportsTo: "person:sam" }, pm: { role: "Planner", reportsTo: "ceo" } },
        relations: [
          { from: "pm", to: "person:sam", type: "dotted-line" },
          { from: "ceo", to: "person:sam", type: "acts-for" },
          { from: "pm", to: "person:alex", type: "acts-for" },
        ],
      },
    }, {}, live)
    const d = view.diagram
    // Kim is in no relation, Alex only acted for: neither gets a card.
    expect(d.boxes.map((b) => [b.key, b.level, b.title])).toEqual([["person:sam", 0, "Owner"], ["agent:ceo", 1, "Boss"], ["agent:pm", 2, "Planner"]])
    expect(d.boxes[0]).not.toHaveProperty("status")
    expect(d.levels).toBe(3)
    const by = (t: string) => d.edges.filter((e) => e.type === t).map((e) => `${e.from}>${e.to}`)
    expect(by("reports-to").sort()).toEqual(["agent:ceo>person:sam", "agent:pm>agent:ceo"])
    expect(by("dotted-line")).toEqual(["agent:pm>person:sam"])
    expect(by("acts-for").sort()).toEqual(["agent:ceo>person:sam", "agent:pm>person:alex"])
    expect(view.problem).toBeUndefined()
  })
})
