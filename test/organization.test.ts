import { describe, it, expect } from "vitest"
import { Organization } from "../src/business/organization"
import { businessConfigSchema, type BusinessConfig } from "../src/business/config"

// Tests for Phase 3 of the architectural rescue — pmFor,
// escalationChain, canHandle. The wiring into decideAndCommit lands
// in a separate flag-gated commit; this tests the pure-function
// scaffolding only.

function makeConfig(overrides: any = {}): BusinessConfig {
  return businessConfigSchema.parse({
    enabled: true,
    timezone: "UTC",
    mainChannel: { channel: "telegram", chatId: "1" },
    workSource: { type: "backlog", path: ".agentx/backlog.md" },
    roles: {
      ceo: { title: "CEO", responsibilities: [], kpis: [] },
      pm: { title: "PM", responsibilities: [], kpis: [] },
      dev: { title: "Dev", responsibilities: [], kpis: [] },
    },
    orgChart: {
      ceo: { role: "ceo", schedule: { start: "09:00", end: "17:00" }, utilizationTarget: 0.8 },
      "pm-globex": { role: "pm", reportsTo: "ceo", schedule: { start: "09:00", end: "17:00" }, utilizationTarget: 0.8 },
      "globex-v2": { role: "dev", reportsTo: "pm-globex", schedule: { start: "09:00", end: "17:00" }, utilizationTarget: 0.8 },
      "globex-v1": { role: "dev", reportsTo: "pm-globex", schedule: { start: "09:00", end: "17:00" }, utilizationTarget: 0.8 },
    },
    projects: [
      { id: "globex/globex-system-v2", pm: "pm-globex" },
      { id: "acme/website" }, // no pm
    ],
    ...overrides,
  })
}

describe("Organization.pmFor", () => {
  it("returns the configured PM for a project", () => {
    const org = new Organization(makeConfig())
    expect(org.pmFor("globex/globex-system-v2")).toBe("pm-globex")
  })

  it("returns undefined for a project without a PM", () => {
    const org = new Organization(makeConfig())
    expect(org.pmFor("acme/website")).toBeUndefined()
  })

  it("returns undefined for an unknown project", () => {
    const org = new Organization(makeConfig())
    expect(org.pmFor("unknown/project")).toBeUndefined()
  })

  it("returns undefined for null/undefined project (router-style events)", () => {
    const org = new Organization(makeConfig())
    expect(org.pmFor(null)).toBeUndefined()
    expect(org.pmFor(undefined)).toBeUndefined()
  })

  it("constructor rejects projects whose PM isn't in the org chart", () => {
    expect(() =>
      new Organization(makeConfig({
        projects: [{ id: "x/y", pm: "ghost-agent" }],
      })),
    ).toThrow(/unknown PM/)
  })
})

describe("Organization.escalationChain", () => {
  it("excludes the agent itself, includes all reports-to ancestors", () => {
    const org = new Organization(makeConfig())
    expect(org.escalationChain("globex-v2")).toEqual(["pm-globex", "ceo"])
  })

  it("returns empty for the root of the org tree", () => {
    const org = new Organization(makeConfig())
    expect(org.escalationChain("ceo")).toEqual([])
  })

  it("returns empty for an unknown agent (no chain to walk)", () => {
    const org = new Organization(makeConfig())
    expect(org.escalationChain("unknown")).toEqual([])
  })
})

describe("Organization.canHandle", () => {
  it("returns true for any registered agent (permissive scaffold; per-capability check in Phase 5)", () => {
    const org = new Organization(makeConfig())
    expect(org.canHandle("globex-v2", "globex/globex-system-v2", "issue.opened")).toBe(true)
    expect(org.canHandle("ceo", "globex/globex-system-v2", "issue.opened")).toBe(true)
  })

  it("returns false for an agent not in the org chart", () => {
    const org = new Organization(makeConfig())
    expect(org.canHandle("ghost-agent", "any/project", "any.intent")).toBe(false)
  })

  it("works with null project / intent (router-style events)", () => {
    const org = new Organization(makeConfig())
    expect(org.canHandle("globex-v2", null, null)).toBe(true)
  })

  it("returns true for ANY agent when orgChart is empty (permissive-when-unconfigured)", () => {
    // Real-world case: operator enables business + populates
    // projects[].pm to use the PM gate, but hasn't filled orgChart.
    // Without this fallback, every dispatch would halt with
    // "agent X cannot handle" since employees.has() returns false
    // for every agent. Empty-chart = permissive sidesteps that.
    const cfg = businessConfigSchema.parse({
      enabled: true, timezone: "UTC",
      mainChannel: { channel: "telegram", chatId: "1" },
      workSource: { type: "backlog", path: ".agentx/backlog.md" },
      // roles + orgChart left as defaults (empty)
      projects: [{ id: "p1", pm: "pm-x" }], // still allowed even though pm-x isn't in orgChart? No — let's drop it; the constructor validates pm presence
    })
    const org = new Organization({ ...cfg, projects: [] })
    expect(org.canHandle("any-agent", "any/project", "any.intent")).toBe(true)
    expect(org.canHandle("ghost", null, null)).toBe(true)
  })
})

describe("Organization — backwards compatibility", () => {
  it("config without `projects` field validates and constructs an empty project map", () => {
    const cfg = businessConfigSchema.parse({
      enabled: true,
      timezone: "UTC",
      mainChannel: { channel: "telegram", chatId: "1" },
      workSource: { type: "backlog", path: ".agentx/backlog.md" },
      roles: { ceo: { title: "CEO", responsibilities: [], kpis: [] } },
      orgChart: {
        ceo: { role: "ceo", schedule: { start: "09:00", end: "17:00" }, utilizationTarget: 0.8 },
      },
      // no projects key — schema default kicks in
    })
    const org = new Organization(cfg)
    expect(org.pmFor("anything")).toBeUndefined()
  })
})

// People and typed relations in the org chart (#1418).
describe("Organization — people and typed relations", () => {
  const people = [
    { id: "sam", name: "Sam Rivera", role: "owner" },
    { id: "kim", name: "Kim Lee", role: "member" },
  ]

  it("lets a person be a boss through a legacy-style orgChart.reportsTo", () => {
    const base = makeConfig()
    const org = new Organization(makeConfig({
      orgChart: { ...base.orgChart, ceo: { ...base.orgChart.ceo, reportsTo: "person:sam" } },
    }), people)
    expect(org.managerOf("agent:ceo")).toBe("person:sam")
    expect(org.get("ceo")?.reportsTo).toBeUndefined()
    expect(org.get("ceo")?.manager).toBe("person:sam")
    expect(org.people().map((p) => p.id)).toEqual(["sam"])
    expect(org.nameOf("person:sam")).toBe("Sam Rivera")
  })

  it("lets a person be a boss through business.relations", () => {
    const org = new Organization(makeConfig({
      relations: [{ from: "agent:ceo", to: "person:sam", type: "reports-to" }],
    }), people)
    expect(org.managerOf("agent:ceo")).toBe("person:sam")
    expect(org.relations()).toContainEqual({ from: "agent:ceo", to: "person:sam", type: "reports-to" })
  })

  it("reads a legacy bare reportsTo as reports-to between agents", () => {
    const org = new Organization(makeConfig())
    expect(org.reportsTo("pm-globex")).toBe("ceo")
    expect(org.managerOf("agent:pm-globex")).toBe("agent:ceo")
    expect(org.relations()).toContainEqual({ from: "agent:globex-v2", to: "agent:pm-globex", type: "reports-to" })
    expect(org.directReports("pm-globex").sort()).toEqual(["globex-v1", "globex-v2"])
  })

  it("rejects an unknown person or agent with a clear error", () => {
    expect(() => new Organization(makeConfig({
      relations: [{ from: "agent:ceo", to: "person:ghost", type: "reports-to" }],
    }), people)).toThrow(/unknown person "ghost" \(not in people\)/)
    expect(() => new Organization(makeConfig({
      relations: [{ from: "agent:nobody", to: "person:sam", type: "dotted-line" }],
    }), people)).toThrow(/unknown agent "nobody"/)
    const base = makeConfig()
    expect(() => new Organization(makeConfig({
      orgChart: { ...base.orgChart, ceo: { ...base.orgChart.ceo, reportsTo: "ghost" } },
    }), people)).toThrow(/reports to: unknown agent "ghost"/)
  })

  it("rejects a member written without agent: or person: in relations", () => {
    expect(() => makeConfig({ relations: [{ from: "ceo", to: "person:sam", type: "reports-to" }] })).toThrow(/agent:<id> or person:<id>/)
  })

  it("detects a reports-to cycle through a person", () => {
    expect(() => new Organization(makeConfig({
      relations: [
        { from: "agent:ceo", to: "person:sam", type: "reports-to" },
        { from: "person:sam", to: "agent:globex-v2", type: "reports-to" },
      ],
    }), people)).toThrow(/Reporting cycle detected involving/)
  })

  it("allows one reports-to per member, many dotted-lines", () => {
    expect(() => new Organization(makeConfig({
      relations: [{ from: "agent:pm-globex", to: "person:sam", type: "reports-to" }],
    }), people)).toThrow(/already reports to agent:ceo/)
    const org = new Organization(makeConfig({
      relations: [
        { from: "agent:globex-v2", to: "person:sam", type: "dotted-line" },
        { from: "agent:globex-v2", to: "person:kim", type: "dotted-line" },
      ],
    }), people)
    expect(org.relations().filter((r) => r.type === "dotted-line")).toHaveLength(2)
    // Dotted lines never feed escalation.
    expect(org.escalationChain("globex-v2")).toEqual(["pm-globex", "ceo"])
  })

  it("accepts acts-for only from an agent to a person", () => {
    expect(() => new Organization(makeConfig({
      relations: [{ from: "agent:globex-v2", to: "person:sam", type: "acts-for" }],
    }), people)).not.toThrow()
    expect(() => new Organization(makeConfig({
      relations: [{ from: "person:sam", to: "agent:ceo", type: "acts-for" }],
    }), people)).toThrow(/acts-for links an agent to a person/)
    expect(() => new Organization(makeConfig({
      relations: [{ from: "agent:globex-v2", to: "agent:ceo", type: "acts-for" }],
    }), people)).toThrow(/acts-for links an agent to a person/)
  })

  it("stops escalation at a person: it never dispatches to a person", () => {
    const base = makeConfig()
    const org = new Organization(makeConfig({
      orgChart: { ...base.orgChart, "pm-globex": { ...base.orgChart["pm-globex"], reportsTo: "person:sam" } },
      relations: [{ from: "person:sam", to: "agent:ceo", type: "reports-to" }],
    }), people)
    expect(org.escalationChain("globex-v2")).toEqual(["pm-globex"])
    expect(org.chainOfCommand("pm-globex")).toEqual(["pm-globex"])
    expect(org.managerOf("person:sam")).toBe("agent:ceo")
  })
})
