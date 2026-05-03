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
      "pm-mtgl": { role: "pm", reportsTo: "ceo", schedule: { start: "09:00", end: "17:00" }, utilizationTarget: 0.8 },
      "mtgl-v2": { role: "dev", reportsTo: "pm-mtgl", schedule: { start: "09:00", end: "17:00" }, utilizationTarget: 0.8 },
      "mtgl-v1": { role: "dev", reportsTo: "pm-mtgl", schedule: { start: "09:00", end: "17:00" }, utilizationTarget: 0.8 },
    },
    projects: [
      { id: "mtgl/mtgl-system-v2", pm: "pm-mtgl" },
      { id: "noqta/website" }, // no pm
    ],
    ...overrides,
  })
}

describe("Organization.pmFor", () => {
  it("returns the configured PM for a project", () => {
    const org = new Organization(makeConfig())
    expect(org.pmFor("mtgl/mtgl-system-v2")).toBe("pm-mtgl")
  })

  it("returns undefined for a project without a PM", () => {
    const org = new Organization(makeConfig())
    expect(org.pmFor("noqta/website")).toBeUndefined()
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
    expect(org.escalationChain("mtgl-v2")).toEqual(["pm-mtgl", "ceo"])
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
    expect(org.canHandle("mtgl-v2", "mtgl/mtgl-system-v2", "issue.opened")).toBe(true)
    expect(org.canHandle("ceo", "mtgl/mtgl-system-v2", "issue.opened")).toBe(true)
  })

  it("returns false for an agent not in the org chart", () => {
    const org = new Organization(makeConfig())
    expect(org.canHandle("ghost-agent", "any/project", "any.intent")).toBe(false)
  })

  it("works with null project / intent (router-style events)", () => {
    const org = new Organization(makeConfig())
    expect(org.canHandle("mtgl-v2", null, null)).toBe(true)
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
